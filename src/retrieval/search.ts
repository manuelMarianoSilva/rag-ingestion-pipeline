import pg from "pg";
import { embedQuery } from "../embeddings/client.js";
import type { SourceType, SymbolType } from "../types.js";

export interface SearchResult {
  chunkId: string;
  sourceId: string;
  sourceType: SourceType;
  repo?: string;
  filePath?: string;
  symbolName?: string;
  symbolType?: SymbolType;
  displayContent: string;
  url?: string;
  score: number; // fused RRF score, not a probability -- only meaningful for relative ranking
}

export interface SearchOptions {
  limit?: number;
  repo?: string;
  sourceType?: SourceType;
}

const DEFAULT_LIMIT = 10;
const CANDIDATE_LIMIT = 30; // per-list candidate pool size, before RRF fusion trims to `limit`
const RRF_K = 60; // standard RRF damping constant -- de-emphasizes low ranks without a hard cutoff

interface CandidateRow {
  chunk_id: string;
  source_id: string;
  source_type: SourceType;
  repo: string | null;
  file_path: string | null;
  symbol_name: string | null;
  symbol_type: SymbolType | null;
  display_content: string;
  url: string | null;
}

/** pgvector expects `'[0.1,0.2,...]'` literals for the `::vector` cast -- node-postgres doesn't do this conversion natively. */
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

function buildFilterClause(
  opts: SearchOptions,
  startIndex: number
): { clause: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let i = startIndex;

  if (opts.repo) {
    conditions.push(`repo = $${i++}`);
    params.push(opts.repo);
  }
  if (opts.sourceType) {
    conditions.push(`source_type = $${i++}`);
    params.push(opts.sourceType);
  }

  return { clause: conditions.length ? `AND ${conditions.join(" AND ")}` : "", params };
}

async function denseSearch(
  pool: pg.Pool,
  queryEmbedding: number[],
  opts: SearchOptions
): Promise<CandidateRow[]> {
  const { clause, params } = buildFilterClause(opts, 3);
  const res = await pool.query(
    `SELECT chunk_id, source_id, source_type, repo, file_path, symbol_name, symbol_type, display_content, url
     FROM chunks
     WHERE embedding IS NOT NULL ${clause}
     ORDER BY embedding <=> $1::vector
     LIMIT $2`,
    [toVectorLiteral(queryEmbedding), CANDIDATE_LIMIT, ...params]
  );
  return res.rows;
}

async function lexicalSearch(
  pool: pg.Pool,
  query: string,
  opts: SearchOptions
): Promise<CandidateRow[]> {
  const { clause, params } = buildFilterClause(opts, 3);
  const res = await pool.query(
    `SELECT chunk_id, source_id, source_type, repo, file_path, symbol_name, symbol_type, display_content, url
     FROM chunks
     WHERE content_tsv @@ plainto_tsquery('english', $1) ${clause}
     ORDER BY ts_rank(content_tsv, plainto_tsquery('english', $1)) DESC
     LIMIT $2`,
    [query, CANDIDATE_LIMIT, ...params]
  );
  return res.rows;
}

/**
 * Fuses two ranked candidate lists via reciprocal rank fusion: each chunk's
 * score is the sum, over every list it appears in, of 1 / (k + rank). This
 * avoids needing to normalize cosine distance and ts_rank onto a common
 * scale, which the original architecture discussion flagged as a common
 * pitfall of naive hybrid-search merging.
 */
function fuseRankedLists(lists: CandidateRow[][]): Map<string, { row: CandidateRow; score: number }> {
  const fused = new Map<string, { row: CandidateRow; score: number }>();

  for (const list of lists) {
    list.forEach((row, rank) => {
      const contribution = 1 / (RRF_K + rank + 1); // rank is 0-indexed; RRF conventionally uses 1-indexed rank
      const existing = fused.get(row.chunk_id);
      if (existing) {
        existing.score += contribution;
      } else {
        fused.set(row.chunk_id, { row, score: contribution });
      }
    });
  }

  return fused;
}

function toSearchResult(row: CandidateRow, score: number): SearchResult {
  return {
    chunkId: row.chunk_id,
    sourceId: row.source_id,
    sourceType: row.source_type,
    repo: row.repo ?? undefined,
    filePath: row.file_path ?? undefined,
    symbolName: row.symbol_name ?? undefined,
    symbolType: row.symbol_type ?? undefined,
    displayContent: row.display_content,
    url: row.url ?? undefined,
    score,
  };
}

/**
 * Hybrid code search: embeds `query` (as a query, not a document -- see
 * `embedQuery`), runs dense (pgvector cosine) and lexical (`content_tsv`)
 * candidate searches in parallel, and fuses them via RRF.
 *
 * No reranking and no symbol-graph expansion here by design -- see the
 * retrieval-layer plan for what's deliberately deferred.
 */
export async function searchCode(
  pool: pg.Pool,
  query: string,
  opts: SearchOptions = {}
): Promise<SearchResult[]> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const queryEmbedding = await embedQuery(query);

  const [dense, lexical] = await Promise.all([
    denseSearch(pool, queryEmbedding, opts),
    lexicalSearch(pool, query, opts),
  ]);

  const fused = fuseRankedLists([dense, lexical]);
  const ranked = [...fused.values()].sort((a, b) => b.score - a.score);

  return ranked.slice(0, limit).map(({ row, score }) => toSearchResult(row, score));
}
