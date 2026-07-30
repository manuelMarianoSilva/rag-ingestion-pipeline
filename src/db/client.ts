import pg from "pg";
import type { EmbeddedChunk } from "../types.js";

const { Pool } = pg;

export function createDbPool(): pg.Pool {
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
  });
}

/**
 * Upserts a chunk. Skips the write entirely if content_hash is unchanged
 * from what's stored -- this is the mechanism that avoids re-embedding
 * (and re-paying for) files that haven't changed between syncs.
 *
 * Call `hasChunkChanged` before generating an embedding, not after --
 * embeddings are the expensive part, so skip them, not just the DB write.
 */
export async function hasChunkChanged(
  pool: pg.Pool,
  chunkId: string,
  contentHash: string
): Promise<boolean> {
  const res = await pool.query(
    `SELECT content_hash FROM chunks WHERE chunk_id = $1`,
    [chunkId]
  );
  if (res.rowCount === 0) return true;
  return res.rows[0].content_hash !== contentHash;
}

export async function upsertChunk(pool: pg.Pool, chunk: EmbeddedChunk): Promise<void> {
  const m = chunk.metadata;
  await pool.query(
    `INSERT INTO chunks (
      chunk_id, source_type, source_id, content, display_content,
      repo, file_path, language, symbol_name, symbol_type,
      start_line, end_line, imports, calls, extends_symbols, implements_symbols,
      exported, framework_markers,
      url, last_modified, content_hash, embedding, updated_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22, now()
    )
    ON CONFLICT (chunk_id) DO UPDATE SET
      content = EXCLUDED.content,
      display_content = EXCLUDED.display_content,
      symbol_name = EXCLUDED.symbol_name,
      symbol_type = EXCLUDED.symbol_type,
      start_line = EXCLUDED.start_line,
      end_line = EXCLUDED.end_line,
      imports = EXCLUDED.imports,
      calls = EXCLUDED.calls,
      extends_symbols = EXCLUDED.extends_symbols,
      implements_symbols = EXCLUDED.implements_symbols,
      exported = EXCLUDED.exported,
      framework_markers = EXCLUDED.framework_markers,
      last_modified = EXCLUDED.last_modified,
      content_hash = EXCLUDED.content_hash,
      embedding = EXCLUDED.embedding,
      updated_at = now();`,
    [
      chunk.chunkId,
      chunk.sourceType,
      chunk.sourceId,
      chunk.content,
      chunk.displayContent,
      m.repo ?? null,
      m.filePath ?? null,
      m.language ?? null,
      m.symbolName ?? null,
      m.symbolType ?? null,
      m.startLine ?? null,
      m.endLine ?? null,
      m.imports ?? [],
      m.calls ?? [],
      m.extendsSymbols ?? [],
      m.implementsSymbols ?? [],
      m.exported ?? false,
      m.frameworkMarkers ?? [],
      m.url ?? null,
      m.lastModified ?? null,
      m.contentHash,
      JSON.stringify(chunk.embedding),
    ]
  );
}

/**
 * Deletes chunks belonging to source files that no longer exist
 * (e.g. a file was deleted or renamed in the repo). Call this per-file
 * during sync with the set of chunk_ids you just wrote for that file.
 */
export async function pruneStaleChunksForSource(
  pool: pg.Pool,
  sourceId: string,
  keepChunkIds: string[]
): Promise<void> {
  await pool.query(
    `DELETE FROM chunks WHERE source_id = $1 AND NOT (chunk_id = ANY($2::text[]))`,
    [sourceId, keepChunkIds]
  );
}
