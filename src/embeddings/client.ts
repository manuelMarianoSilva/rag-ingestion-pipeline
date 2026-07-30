const JINA_ENDPOINT = "https://api.jina.ai/v1/embeddings";
const EMBEDDING_MODEL = "jina-code-embeddings-1.5b"; // code-specialized model; free tier eligible
// see https://jina.ai/models/jina-code-embeddings-1.5b/
const OUTPUT_DIMENSION = 1024; // Matryoshka-truncated from the model's native 1536 dims --
// keeps this compatible with the existing `vector(1024)` column in schema.sql
const BATCH_SIZE = 128; // Jina has no hard per-request item cap, but keep batches modest
// to stay well under the free tier's 100,000 TPM limit

interface JinaResponse {
  data: { embedding: number[]; index: number }[];
}

/** Distinguishes transient rate-limit errors (retry as-is) from genuine content/encode failures (need split fallback). */
class JinaRateLimitError extends Error {}

const MAX_RATE_LIMIT_RETRIES = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retries on transient 429s with jittered exponential backoff; any other error propagates immediately. */
async function withRateLimitRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof JinaRateLimitError) || attempt >= MAX_RATE_LIMIT_RETRIES) throw err;
      const backoffMs = 1000 * 2 ** attempt + Math.random() * 500;
      console.warn(
        `[embeddings] rate limited (attempt ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES}), backing off ${Math.round(backoffMs)}ms`
      );
      await sleep(backoffMs);
    }
  }
}

async function embedRequest(input: string[]): Promise<number[][]> {
  const res = await fetch(JINA_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.JINA_API_KEY}`,
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input,
      task: "nl2code.passage",
      dimensions: OUTPUT_DIMENSION,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 429) {
      throw new JinaRateLimitError(`Jina embeddings request failed (429): ${body}`);
    }
    throw new Error(`Jina embeddings request failed (${res.status}): ${body}`);
  }

  const json = (await res.json()) as JinaResponse;
  // Jina returns results tagged with their original index -- sort defensively
  // rather than assuming array order matches input order.
  return [...json.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

const MAX_SPLIT_DEPTH = 4; // 2^4 = 16 pieces at worst, plenty for the pathological cases seen so far
const MIN_SPLITTABLE_LENGTH = 200; // below this, splitting further isn't worth it -- just give up

/** Picks a split point near the midpoint, preferring a newline so halves stay reasonably coherent. */
function findSplitPoint(text: string): number {
  const mid = Math.floor(text.length / 2);
  const newlineIdx = text.indexOf("\n", mid);
  return newlineIdx === -1 ? mid : newlineIdx;
}

/** Length-weighted mean of two embeddings, re-normalized to unit length (both inputs are already unit vectors). */
function averageEmbeddings(a: number[], b: number[], weightA: number, weightB: number): number[] {
  const total = weightA + weightB;
  const avg = a.map((v, i) => (v * weightA + b[i] * weightB) / total);
  const norm = Math.sqrt(avg.reduce((sum, v) => sum + v * v, 0)) || 1;
  return avg.map((v) => v / norm);
}

/**
 * Embeds a single text, recursively bisecting it if Jina's tokenizer rejects
 * it outright. Observed in practice: Jina occasionally returns a generic
 * "Failed to encode text" 400 for one specific text with nothing unusual
 * about it (no non-ASCII bytes, not simply a length issue -- arbitrary
 * substrings of the exact same text embed fine). Splitting and averaging is
 * an imperfect approximation of the whole text's embedding, but far better
 * than losing the chunk entirely.
 *
 * Transient 429s are retried in place (via `withRateLimitRetry`) rather than
 * treated as a content problem -- splitting the text does nothing to fix a
 * concurrency-limit error, and would only burn split depth on a text that
 * was never actually unencodable.
 */
async function embedTextWithSplitFallback(text: string, depth = 0): Promise<number[] | null> {
  try {
    const [embedding] = await withRateLimitRetry(() => embedRequest([text]));
    return embedding;
  } catch (err) {
    if (depth >= MAX_SPLIT_DEPTH || text.length < MIN_SPLITTABLE_LENGTH) {
      console.error(`[embeddings] giving up after ${depth} split(s), text still fails to embed: ${err}`);
      return null;
    }

    const splitAt = findSplitPoint(text);
    const left = text.slice(0, splitAt);
    const right = text.slice(splitAt);
    const [leftEmbedding, rightEmbedding] = await Promise.all([
      embedTextWithSplitFallback(left, depth + 1),
      embedTextWithSplitFallback(right, depth + 1),
    ]);

    if (leftEmbedding && rightEmbedding) {
      return averageEmbeddings(leftEmbedding, rightEmbedding, left.length, right.length);
    }
    return leftEmbedding ?? rightEmbedding;
  }
}

/**
 * Embeds a batch of texts using Jina AI's code-specialized embedding model.
 * Returns embeddings in the same order as input; entries that couldn't be
 * embedded even after the split fallback are `null` rather than failing the
 * whole batch, so callers must handle holes in the result array.
 *
 * `task: "nl2code.passage"` tells Jina these are code documents being indexed
 * (as opposed to a natural-language search query) -- Jina uses asymmetric
 * encoding internally, so the retrieval-time query embedding call (in the
 * future retrieval service) should pass `task: "nl2code.query"` instead of
 * "nl2code.passage".
 */
export async function embedBatch(texts: string[]): Promise<(number[] | null)[]> {
  const results: (number[] | null)[] = new Array(texts.length).fill(null);

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);

    try {
      const embeddings = await withRateLimitRetry(() => embedRequest(batch));
      embeddings.forEach((embedding, j) => {
        results[i + j] = embedding;
      });
    } catch (err) {
      // One bad text can 400 the whole batch (rate limits are already retried
      // above and only reach here once exhausted) -- fall back to embedding
      // one at a time (with further recursive splitting per-item) so only
      // the actually-problematic item is at risk of being skipped.
      console.warn(
        `[embeddings] batch of ${batch.length} failed (${err}), retrying items individually`
      );
      for (let j = 0; j < batch.length; j++) {
        results[i + j] = await embedTextWithSplitFallback(batch[j]);
      }
    }
  }

  return results;
}

/**
 * Embeds a single search query using Jina's code-specialized embedding model.
 *
 * Uses `task: "nl2code.query"` -- the counterpart to `embedBatch`'s
 * `"nl2code.passage"` -- since Jina's asymmetric encoding produces different
 * vectors for queries vs. documents even for the same model. Mixing the two
 * task flags between indexing and retrieval will silently degrade search
 * quality, so this must stay in sync with `embedBatch`.
 */
export async function embedQuery(text: string): Promise<number[]> {
  const res = await fetch(JINA_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.JINA_API_KEY}`,
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: [text],
      task: "nl2code.query",
      dimensions: OUTPUT_DIMENSION,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jina embeddings request failed (${res.status}): ${body}`);
  }

  const json = (await res.json()) as JinaResponse;
  return json.data[0].embedding;
}