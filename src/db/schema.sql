-- Run once per environment. Requires the pgvector extension available
-- (e.g. use the pgvector/pgvector:pg16 Docker image, or enable the
-- extension on a managed Postgres that supports it, like Supabase/Neon/RDS).

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS chunks (
  chunk_id          TEXT PRIMARY KEY,
  source_type       TEXT NOT NULL,          -- 'code' | 'confluence' | 'jira'
  source_id         TEXT NOT NULL,          -- e.g. github:acme/web-app:src/Login.tsx
  content           TEXT NOT NULL,          -- embedded text (header + code)
  display_content   TEXT NOT NULL,          -- what gets shown back to caller
  repo              TEXT,
  file_path         TEXT,
  language          TEXT,
  symbol_name       TEXT,
  symbol_type       TEXT,
  start_line        INT,
  end_line          INT,
  imports           TEXT[] DEFAULT '{}',
  calls             TEXT[] DEFAULT '{}',
  extends_symbols   TEXT[] DEFAULT '{}',
  implements_symbols TEXT[] DEFAULT '{}',
  exported          BOOLEAN DEFAULT false,
  framework_markers TEXT[] DEFAULT '{}',
  url               TEXT,
  last_modified     TIMESTAMPTZ,
  content_hash      TEXT NOT NULL,          -- used to skip re-embedding unchanged chunks
  embedding         vector(1024),           -- jina-code-embeddings-1.5b, Matryoshka-truncated from 1536 (adjust if you swap models)
  content_tsv       TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', coalesce(display_content, ''))) STORED,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Backfills the three symbol-graph columns onto a `chunks` table that already
-- existed before they were added -- CREATE TABLE IF NOT EXISTS above is a
-- no-op once the table exists, so these need to be explicit and idempotent.
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS calls TEXT[] DEFAULT '{}';
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS extends_symbols TEXT[] DEFAULT '{}';
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS implements_symbols TEXT[] DEFAULT '{}';

-- Vector similarity search (cosine). ivfflat requires ANALYZE after bulk load;
-- switch to hnsw (pgvector >= 0.5) if your version supports it -- fewer tuning knobs.
CREATE INDEX IF NOT EXISTS chunks_embedding_idx
  ON chunks USING hnsw (embedding vector_cosine_ops);

-- Lexical/BM25-style search
CREATE INDEX IF NOT EXISTS chunks_tsv_idx ON chunks USING GIN (content_tsv);

-- Common metadata filters
CREATE INDEX IF NOT EXISTS chunks_repo_idx ON chunks (repo);
CREATE INDEX IF NOT EXISTS chunks_source_type_idx ON chunks (source_type);
CREATE INDEX IF NOT EXISTS chunks_symbol_name_idx ON chunks (symbol_name);

-- Lightweight symbol graph: edges between symbols for get_symbol_context.
-- Populated by populateSymbolGraph() (src/graph/populate.ts) at the end of every syncRepo() call.
CREATE TABLE IF NOT EXISTS symbol_edges (
  id             BIGSERIAL PRIMARY KEY,
  repo           TEXT NOT NULL,
  from_symbol    TEXT NOT NULL,   -- fully-qualified: repo:filePath:symbolName
  to_symbol      TEXT NOT NULL,
  relationship   TEXT NOT NULL,   -- 'imports' | 'calls' | 'extends' | 'implements'
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS symbol_edges_from_idx ON symbol_edges (from_symbol);
CREATE INDEX IF NOT EXISTS symbol_edges_to_idx ON symbol_edges (to_symbol);
