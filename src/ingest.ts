import "dotenv/config";
import pLimit from "p-limit";
import { GithubConnector, type GithubSyncTarget } from "./connectors/github.js";
import { GitlabConnector, type GitlabSyncTarget } from "./connectors/gitlab.js";
import { BitbucketConnector, type BitbucketSyncTarget } from "./connectors/bitbucket.js";
import { ConfluenceConnector, type ConfluenceSyncTarget } from "./connectors/confluence.js";
import { chunkTypeScriptFile } from "./chunkers/typescript.js";
import { chunkJavaFile } from "./chunkers/java.js";
import { chunkPythonFile } from "./chunkers/python.js";
import { chunkConfluencePage } from "./chunkers/confluence.js";
import { embedBatch } from "./embeddings/client.js";
import { createDbPool, upsertChunk, pruneStaleChunksForSource } from "./db/client.js";
import { populateSymbolGraph } from "./graph/populate.js";
import type { Chunk, RawDocument } from "./types.js";
import pg from "pg";

const CONCURRENCY = 2;

/**
 * Structural interface GithubConnector, GitlabConnector, and BitbucketConnector
 * all satisfy, so syncFile/syncRepo don't need to know which provider they're
 * talking to. Adding another provider later only means implementing this shape.
 */
interface Connector<T> {
  listFiles(target: T): Promise<string[]>;
  fetchFile(target: T, path: string): Promise<RawDocument | null>;
}

/** Dispatches to the chunker matching the doc's sourceType (non-code docs) or the file's extension (code). Add new sources/languages here as they're supported. */
function chunkFile(doc: RawDocument): Chunk[] {
  if (doc.sourceType === "confluence") return chunkConfluencePage(doc);
  if (doc.metadata.filePath?.endsWith(".java")) return chunkJavaFile(doc);
  if (doc.metadata.filePath?.endsWith(".py")) return chunkPythonFile(doc);
  return chunkTypeScriptFile(doc);
}

/** Checks if a file's content_hash differs from what's already stored (any chunk for that source_id). */
async function fileHasChanged(pool: pg.Pool, sourceId: string, contentHash: string): Promise<boolean> {
  const res = await pool.query(
    `SELECT content_hash FROM chunks WHERE source_id = $1 LIMIT 1`,
    [sourceId]
  );
  if (res.rowCount === 0) return true; // never seen this file before
  return res.rows[0].content_hash !== contentHash;
}

async function syncFile<T>(
  connector: Connector<T>,
  target: T,
  path: string,
  pool: pg.Pool
): Promise<{ path: string; status: "skipped" | "indexed" | "failed" }> {
  try {
    const doc = await connector.fetchFile(target, path);
    if (!doc) return { path, status: "skipped" };

    const changed = await fileHasChanged(pool, doc.sourceId, doc.metadata.contentHash);
    if (!changed) return { path, status: "skipped" };

    const chunks: Chunk[] = chunkFile(doc);
    const embeddings = await embedBatch(chunks.map((c) => c.content));

    // embedBatch skips (returns null for) individual chunks Jina's tokenizer
    // can't handle rather than failing the whole file -- store what we can.
    const embedded = chunks
      .map((chunk, i) => ({ chunk, embedding: embeddings[i] }))
      .filter((c): c is { chunk: Chunk; embedding: number[] } => c.embedding !== null);

    if (embedded.length < chunks.length) {
      console.warn(
        `[ingest] ${path}: ${chunks.length - embedded.length}/${chunks.length} chunk(s) failed to embed and were skipped`
      );
    }

    for (const { chunk, embedding } of embedded) {
      await upsertChunk(pool, { ...chunk, embedding });
    }

    await pruneStaleChunksForSource(
      pool,
      doc.sourceId,
      embedded.map((c) => c.chunk.chunkId)
    );

    return { path, status: embedded.length > 0 ? "indexed" : "failed" };
  } catch (err) {
    console.error(`[ingest] failed on ${path}:`, err);
    return { path, status: "failed" };
  }
}

async function syncRepo<T>(connector: Connector<T>, target: T, repoLabel: string): Promise<void> {
  const pool = createDbPool();
  const limit = pLimit(CONCURRENCY);

  console.log(`[ingest] listing files for ${repoLabel}...`);
  const paths = await connector.listFiles(target);
  console.log(`[ingest] found ${paths.length} ingestible files`);

  const results = await Promise.all(
    paths.map((path) => limit(() => syncFile(connector, target, path, pool)))
  );

  const summary = results.reduce(
    (acc, r) => {
      acc[r.status]++;
      return acc;
    },
    { skipped: 0, indexed: 0, failed: 0 } as Record<string, number>
  );

  console.log(
    `[ingest] done. indexed=${summary.indexed} skipped(unchanged)=${summary.skipped} failed=${summary.failed}`
  );

  console.log(`[ingest] rebuilding symbol graph for ${repoLabel}...`);
  await populateSymbolGraph(pool, repoLabel);

  await pool.end();
}

// Example runs:
//   tsx src/ingest.ts acme/web-app main                  (GitHub, default)
//   tsx src/ingest.ts gitlab:group/project main           (GitLab)
//   tsx src/ingest.ts bitbucket:workspace/repo-slug main  (Bitbucket Cloud)
//   tsx src/ingest.ts confluence:SPACEKEY                 (Confluence Cloud; ref is ignored)
const [rawTarget, ref] = process.argv.slice(2);
if (!rawTarget) {
  console.error(
    "Usage: tsx src/ingest.ts [gitlab:|bitbucket:|confluence:]<owner/repo, group/project, workspace/repo-slug, or SPACEKEY> [ref]"
  );
  process.exit(1);
}

const GITLAB_PREFIX = "gitlab:";
const BITBUCKET_PREFIX = "bitbucket:";
const CONFLUENCE_PREFIX = "confluence:";

if (rawTarget.startsWith(CONFLUENCE_PREFIX)) {
  const spaceKey = rawTarget.slice(CONFLUENCE_PREFIX.length);
  const connector = new ConfluenceConnector(
    process.env.CONFLUENCE_BASE_URL!,
    process.env.CONFLUENCE_EMAIL,
    process.env.CONFLUENCE_TOKEN
  );
  const target: ConfluenceSyncTarget = { spaceKey };
  syncRepo(connector, target, `confluence:${spaceKey}`).catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else if (rawTarget.startsWith(GITLAB_PREFIX)) {
  const projectPath = rawTarget.slice(GITLAB_PREFIX.length);
  const connector = new GitlabConnector(process.env.GITLAB_TOKEN!);
  const target: GitlabSyncTarget = { projectPath, ref };
  syncRepo(connector, target, projectPath).catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else if (rawTarget.startsWith(BITBUCKET_PREFIX)) {
  const [workspace, repoSlug] = rawTarget.slice(BITBUCKET_PREFIX.length).split("/");
  const connector = new BitbucketConnector(process.env.BITBUCKET_TOKEN, process.env.BITBUCKET_EMAIL);
  const target: BitbucketSyncTarget = { workspace, repoSlug, ref };
  syncRepo(connector, target, `${workspace}/${repoSlug}`).catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  const [owner, repo] = rawTarget.split("/");
  const connector = new GithubConnector(process.env.GITHUB_TOKEN!);
  const target: GithubSyncTarget = { owner, repo, ref };
  syncRepo(connector, target, `${owner}/${repo}`).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
