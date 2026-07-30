# RAG Ingestion Pipeline — v1 slice (GitHub/GitLab/Bitbucket/Confluence + TypeScript/TSX/Java/Python)

This is the first vertical slice of the ingestion pipeline: three code providers
(GitHub, GitLab, and Bitbucket Cloud), three languages (TypeScript/TSX, covers React;
Java, covers Spring Boot backends; and Python, covers FastAPI/Flask/Bottle/Django
backends), one documentation provider (Confluence Cloud), one vector store
(Postgres + pgvector).
Everything is built behind the seams described below so adding
Jira later means writing a new connector/chunker, not touching this code.

## Architecture recap

```
GithubConnector / GitlabConnector / BitbucketConnector .fetchFile()  ->  RawDocument (sourceType: "code")
ConfluenceConnector .fetchFile()                                     ->  RawDocument (sourceType: "confluence")
        |
chunkFile() dispatches by sourceType first, then by extension:
  chunkConfluencePage()       ->  Chunk[]        (sourceType: "confluence", heading-tree split)
  chunkTypeScriptFile()      ->  Chunk[]        (.ts/.tsx, tree-sitter, symbol-level)
  chunkJavaFile()            ->  Chunk[]        (.java, tree-sitter, method-level)
  chunkPythonFile()          ->  Chunk[]        (.py, tree-sitter, method-level)
        |
embedBatch()                 ->  number[][]     (Jina jina-code-embeddings-1.5b)
        |
upsertChunk()                 ->  Postgres (pgvector + tsvector, dedup by content_hash)
        |
populateSymbolGraph()         ->  Postgres (symbol_edges, rebuilt after every full repo sync; Confluence chunks contribute zero edges)
```

Provider selection is generic: `src/ingest.ts` dispatches to a connector
based on an optional `gitlab:`/`bitbucket:`/`confluence:` prefix on the CLI target, and `syncFile`/`syncRepo`
only depend on the shared structural interface (`listFiles`, `fetchFile`) —
adding another provider later means implementing that interface, not touching
ingestion logic.

The `RawDocument` and `Chunk` types in `src/types.ts` are the common IR —
every future connector/chunker normalizes into these same shapes.

### Java chunking

Unlike the TypeScript chunker (which chunks whole top-level declarations),
`chunkJavaFile()` (`src/chunkers/java.ts`) chunks at the **method level** within
each top-level class/interface/enum/record — this is what addresses the "large
classes chunked whole" limitation for backend service classes (see Known
limitations below; TS/JS chunking granularity is unchanged). Each method chunk
is embedded with its enclosing class's package, imports, and signature line
(including class-level annotations) as header context, plus its own Javadoc.
Types with no methods (DTOs, records, marker interfaces) fall back to one
whole-type chunk, mirroring the TS chunker's whole-file fallback.

It also detects common Spring Boot annotations and attaches them as
`frameworkMarkers`, mirroring the `react-component`/`react-hook` markers the TS
chunker sets: `@RestController`/`@Controller` → `spring-controller`,
`@Service` → `spring-service`, `@Repository` → `spring-repository`,
`@Component` → `spring-component`, `@Entity` → `jpa-entity`. Methods annotated
with `@GetMapping`/`@PostMapping`/`@PutMapping`/`@DeleteMapping`/`@PatchMapping`/`@RequestMapping`
get `symbolType: "endpoint"` plus a `spring-endpoint` marker, the Java
equivalent of the `express-route` detection described below.

### Python chunking

`chunkPythonFile()` (`src/chunkers/python.ts`) chunks the same way as the Java
chunker: **method level** within each top-level class, one chunk per top-level
function, and a whole-class fallback for classes with no methods (Django models,
dataclass-style classes). Each chunk is embedded with the file's imports, its
enclosing class's signature (for methods), and its docstring as header context.
Python docstrings are structurally different from Java/TS doc comments -- they're
the first statement *inside* the body rather than a leading comment -- so they're
deliberately duplicated near the header (in addition to appearing naturally within
the body) so they survive even if a very long function gets truncated by the embedder.

It detects four framework marker groups, the Python equivalents of the Spring and
Express detection above:
- **FastAPI/Flask/Bottle routes**: identifiers assigned via `Flask(...)`,
  `FastAPI(...)`, `APIRouter(...)`, `Blueprint(...)`, or `Bottle(...)` are tracked,
  and `@<app>.get/post/put/delete/patch(path)` or `@<app>.route(path, methods=[...])`
  decorators on them get `symbolType: "endpoint"` plus `fastapi-endpoint` /
  `flask-endpoint` / `bottle-endpoint`. Bottle's bare decorator form (`@route(...)`,
  `@get(...)`, with no app object) is also detected, gated on the name having been
  imported `from bottle import ...` to avoid false positives on unrelated same-named
  functions.
- **Django models**: a class whose base name is/ends with `Model` gets `django-model`.
- **Django views**: a class whose base name is/ends with `View`/`ViewSet` (covers
  Django's own class-based views and DRF's `APIView`/`ModelViewSet` etc.) gets
  `django-view`.
- **Django serializers**: a class whose base name is/ends with `Serializer` (DRF)
  gets `django-serializer`.
- **Django function-based endpoints**: a function decorated with `@api_view([...])`
  (DRF) or `@require_GET`/`@require_POST`/`@require_http_methods([...])` (Django
  core) gets `symbolType: "endpoint"` plus `django-endpoint`.

**Important limitation**: unlike FastAPI/Flask/Bottle, classic Django function-based
views are routed entirely from `urls.py` (`path('users/', views.list_users)`) with
no decorator or naming convention on the view function itself. Since this chunker
only looks at the view file in isolation, undecorated Django FBVs are chunked as
plain functions with no endpoint marker -- only DRF's `@api_view`-decorated views
and Django's `require_*`-decorated views are reliably caught. This is a
meaningfully bigger gap than the Express cross-file-handler limitation below and
would need `urls.py` parsing (or the not-yet-built symbol graph) to close.

### Express/Node route detection

`chunkTypeScriptFile()` also detects Express-style route registrations --
`app.get(path, handler)` / `router.post(path, handler)` / etc. -- and tags them
with `symbolType: "endpoint"` and an `express-route` marker, the TS/JS
counterpart to the Spring endpoint detection above. Detection is **shape-based**
(`<identifier>.<httpVerb>(pathString, ...args)`), not import-verified, so it
will also fire on structurally-identical Fastify or `koa-router` code -- treated
as a feature, not a false positive, since the goal is "this looks like an HTTP
route." To avoid false positives on unrelated `.get()`-style calls (`Map.get()`,
axios/fetch clients, lodash `_.get()`), the object identifier must either be
traced back to an `express()`/`.Router()` call in the same file, or match a name
heuristic (`app`, `router`, or a name ending in `Router`/`App`) for cases like a
router passed in as a function parameter.

Two outcomes depending on the handler:
- **Named handler** (`router.post('/users', createUser)`) -- if `createUser` is
  already a top-level function/const chunk in the same file, that existing
  chunk is enriched in place (`symbolType: "endpoint"`, `express-route` marker,
  a `Route: POST /users` line added to its embedded content) rather than
  emitting a redundant second chunk.
- **Inline handler** (`app.get('/users/:id', (req, res) => {...})`), or a
  named handler that can't be resolved locally (e.g. imported from another
  file) -- a dedicated chunk is emitted for the route-registration statement
  itself, so the route isn't silently dropped even though the real handler body
  isn't available for the imported-handler case (see Known limitations below).

Only `get`/`post`/`put`/`delete`/`patch`/`all` are treated as routes;
`.use()` is deliberately excluded since it's overloaded for generic middleware
mounting and would add significant noise.

### Confluence chunking

`ConfluenceConnector` (`src/connectors/confluence.ts`) fetches each page's
fully-rendered ("view") HTML via the Confluence Cloud REST API v2, converts
it to Markdown with `turndown`, and hands it to `chunkConfluencePage()`
(`src/chunkers/confluence.ts`) — the documentation equivalent of the
tree-sitter AST boundaries the code chunkers use, except headings aren't as
rigid as an AST, so this is bespoke splitting logic rather than a port of the
Java/Python per-method shape:

1. **Heading-tree split**: the page is walked line by line, tracking a stack
   of open headings by level (1-6, ATX-style since turndown is configured
   with `headingStyle: "atx"`). A heading of level `L` closes every open
   section with level ≥ `L`, then opens itself. Each section's *own* body
   (the text directly under it, excluding nested subsections' own text) is
   emitted as one chunk with `symbolType: "section"`, `symbolName` = its own
   heading text, and `metadata.headingPath` = the full breadcrumb from the
   page root (e.g. `["Deployment", "Rollback Procedure"]`). A heading whose
   own body is empty (immediately followed by subheadings) doesn't get a
   chunk of its own, but still contributes to its descendants' breadcrumbs.
2. **Oversized-section fallback**: a section whose own body still exceeds
   ~6000 chars is split into fixed-size overlapping windows, with
   `symbolName` suffixed `(part N)` — mirrors why the code chunkers split at
   the function/method level instead of embedding whole files.
3. **Headingless-page fallback**: a page with no headings at all is chunked
   as a single whole-page chunk with `symbolName: "(page)"`, mirroring the
   code chunkers' whole-file fallback.

Each chunk's embedded text is headed with `Page: {pageTitle}` / `Section:
{headingPath}` / `Labels: {labels}` lines instead of the code chunkers'
`File:`/`Imports:` header. `pageTitle` doubles as the chunk's `filePath`
(itself an ancestor-page breadcrumb built from Confluence's `parentId` chain,
e.g. `"Engineering / Deployment Guide"`), so `search_code`'s existing
`${r.filePath} :: ${r.symbolName}` display line renders sensibly for
Confluence results with zero MCP-side changes. `labels` are fetched
best-effort (a separate, non-fatal API call per page) and folded into the
embedded text, but — unlike `imports`/`calls`/etc. for code — aren't
persisted as their own queryable DB column in this pass (see Known
limitations).

Retrieval (query time, separate from ingestion above):

```
searchCode(query)
        |
embedQuery()                 ->  number[]       (Jina, task=nl2code.query)
        |
dense search (pgvector <=>) + lexical search (content_tsv @@ ...)  -- run in parallel
        |
reciprocal rank fusion       ->  SearchResult[]
        |
search_code MCP tool          ->  formatted text response to the calling agent
```

## Setup

1. **Postgres with pgvector.** Easiest local option:
   ```bash
   docker run -d --name rag-pg -p 5432:5432 \
     -e POSTGRES_PASSWORD=postgres \
     pgvector/pgvector:pg16
   ```
2. **Environment variables** — create `.env`:
   ```
   DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres
   GITHUB_TOKEN=ghp_...          # repo-scoped PAT, or a GitHub App token
   GITLAB_TOKEN=glpat-...        # personal access token with `read_api` scope
   GITLAB_HOST=https://gitlab.com  # optional, defaults to gitlab.com -- point at your self-hosted instance if needed
   BITBUCKET_TOKEN=...           # Bitbucket Cloud credential (Cloud only, bitbucket.org -- no Data Center/Server support). Two shapes are supported:
   BITBUCKET_EMAIL=...           #   1. token + email -> personal Atlassian API token (id.atlassian.com/manage-profile/security/api-tokens), sent as Basic auth (email:token) -- App Passwords were fully retired July 2026.
                                  #   2. token only, no email -> Repository/Workspace/Project Access Token (created inside the repo/workspace's own settings), sent as Bearer. Omit both env vars entirely for anonymous read access to public repos.
   CONFLUENCE_BASE_URL=https://<site>.atlassian.net/wiki  # Confluence Cloud only -- Data Center/Server isn't supported (different API)
   CONFLUENCE_EMAIL=...          # Atlassian account email. Omit both this and CONFLUENCE_TOKEN for anonymous read access to spaces with anonymous access enabled.
   CONFLUENCE_TOKEN=...          # Atlassian API token, same token/scope pattern as BITBUCKET_TOKEN's email+token path -- must have Confluence "Read" scope enabled
   JINA_API_KEY=jina_...         # from https://jina.ai/embeddings -- no card required, 1M free tokens
   ```
3. **Install deps + migrate:**
   ```bash
   npm install
   npm run migrate    # applies src/db/schema.sql
   ```
4. **Run a sync:**
   ```bash
   npm run ingest -- acme/web-app main              # GitHub (default, no prefix)
   npm run ingest -- gitlab:group/project main      # GitLab -- also supports nested groups, e.g. gitlab:group/subgroup/project
   npm run ingest -- bitbucket:workspace/repo-slug main  # Bitbucket Cloud
   npm run ingest -- confluence:SPACEKEY            # Confluence Cloud (ref is ignored -- pages aren't versioned by branch)
   ```

## Smoke-testing the chunker in isolation

`src/chunkers/smoke-test.ts` (TypeScript, including React component/hook and
Express route detection), `src/chunkers/java-smoke-test.ts` (Java),
`src/chunkers/python-smoke-test.ts` (Python), and
`src/chunkers/confluence-smoke-test.ts` (Confluence) run their respective
chunkers against an inline sample file/page with no DB or provider API calls —
useful whenever you touch chunking logic, since chunking quality is the
highest-risk part of this pipeline:
```bash
npx tsx src/chunkers/smoke-test.ts
npm run chunkers:java-smoke-test        # prints per-method chunks + Spring markers for a sample @RestController + DTO record
npm run chunkers:python-smoke-test      # prints per-function/method chunks + FastAPI/Flask/Bottle/Django markers for a sample file
npm run chunkers:confluence-smoke-test  # asserts heading-tree split boundaries + oversized-section windowing on a sample Markdown page
```

## Retrieval layer

Once you've ingested at least one repo, `searchCode()` (`src/retrieval/search.ts`)
does hybrid search over `chunks`: dense (pgvector cosine similarity) and lexical
(`content_tsv` full-text) candidates are fetched in parallel and merged with
reciprocal rank fusion. No reranking yet, and `searchCode()` itself still
doesn't do symbol-graph expansion of its results — `symbol_edges` is populated
(see "Symbol graph" below) but only consulted today via the separate
`get_symbol_context` tool, not folded into `search_code`'s own ranking.

**Smoke-test retrieval directly** against already-ingested data, before going
through MCP:
```bash
npm run retrieval:smoke-test -- acme/web-app
```
Edit the `QUESTIONS` array in `src/retrieval/smoke-test.ts` to match content
that actually exists in whatever repo you point it at.

**Run as an MCP server** so an agent (e.g. Cursor) can call `search_code` directly:
```bash
npm run mcp
```
This starts a stdio MCP server exposing two tools: `search_code(query, repo?, limit?, sourceType?)`
and `get_symbol_context(symbolName, repo)` (see "Symbol graph" below).
`sourceType` (`"code" | "confluence" | "jira"`) restricts results to one
content type — omit it to search code and docs together, which is the point
of a unified RAG assistant.
To register it in Cursor, add to your `mcp.json`:
```json
{
  "mcpServers": {
    "rag-ingestion-pipeline": {
      "command": "npx",
      "args": ["tsx", "${workspaceFolder}/src/mcp/server.ts"],
      "cwd": "${workspaceFolder}"
    }
  }
}
```
`${workspaceFolder}` resolves to the folder containing `.cursor/mcp.json`, so this config works as-is for every teammate without editing an absolute path per machine.

## Symbol graph

Each chunker now captures, alongside the existing per-file `imports` list, two
more per-chunk name references: `calls` (bare callee names referenced within
the symbol's own body, receiver dropped — e.g. `userService.findById()`
records just `findById`) and `extendsSymbols`/`implementsSymbols` (base
class/interface names, from `class_heritage` in TS, `superclass`/`interfaces`
in Java, and the existing Django-heuristic `baseClassNames()` in Python).
Java and Python chunk per-method, so a class's heritage is propagated onto
*every* method chunk of that class, mirroring how `frameworkMarkers` already
propagates class-level Spring/Django annotations onto each method today.

`populateSymbolGraph()` (`src/graph/populate.ts`) runs as the last step of
every `syncRepo()` call: it reads every stored chunk for that repo, indexes
each chunk's `symbolName` (plus a secondary index keyed by the trailing
segment after the last `.`, since callee names never include the receiver),
and resolves each name reference to a same-repo symbol — **best-effort,
name-based matching**, not real static analysis. A name that resolves to
exactly one candidate becomes a `symbol_edges` row; zero candidates (an
import of `react`, a call into a library) or multiple candidates (two files
both define a `validate` method) are both silently skipped rather than
guessed wrong (see Known limitations). This is a full rebuild each time
(delete + reinsert that repo's edges), not incremental — cheap, since it's
pure DB read + name matching with no embedding calls involved.

The resulting graph is queryable via a second MCP tool, `get_symbol_context(symbolName, repo)`
(`src/retrieval/symbolContext.ts`), which returns what a symbol calls/is
called by, extends/is extended by, implements/is implemented by, and
imports/is imported by — each with a short snippet and link back to the
source chunk when it's still indexed.

**Smoke-test the resolution logic** (pure, no DB) against a hand-built set of
chunk records covering a resolvable call edge, a resolvable extends edge, an
ambiguous call, and an unresolvable external import:
```bash
npm run graph:smoke-test
```

## What this slice does NOT yet include (by design — see roadmap)

- **Jira connector** — output `RawDocument` with `sourceType: "jira"`; likely chunked per-issue (description + comments) rather than by heading, since issues don't have Confluence's heading structure.
- **Webhook-triggered incremental sync** — right now `npm run ingest` does a full repo walk; the `content_hash` dedup means unchanged files skip re-embedding, but a webhook listener that calls `filterChangedIngestibleFiles()` on push events (already implemented on the connector) would avoid the full tree walk too.
- **Reranking** — `searchCode()` returns RRF-merged order as final; a cross-encoder rerank pass (e.g. Jina's reranker) would sit between fusion and returning results.
- **Access control** — `searchCode()` has no notion of which repos a caller is allowed to see; anyone who can call the MCP tool can search everything ingested.

## Known limitations worth knowing about

- **TS/JS classes are chunked whole**, not per-method. Fine for most React components/services seen so far — revisit if you start seeing very large TS classes. Java and Python no longer have this limitation: `chunkJavaFile()`/`chunkPythonFile()` chunk at the method level (see "Java chunking"/"Python chunking" above).
- **Express route handlers imported from another file only get a lightweight fallback chunk** — just the route-registration line (`router.post('/users', createUser)`), not the real handler body. The symbol graph's `imports` edges can point `get_symbol_context` at the right file, but nothing pulls the real handler body into the route's own chunk automatically. Handlers defined in the same file (named or inline) get the full enrichment/dedicated-chunk treatment described in "Express/Node route detection" above.
- **Classic Django function-based views have no endpoint marker** — Django routes views entirely from `urls.py`, with no decorator or naming convention on the view function itself, so this chunker (which only looks at one file in isolation) can't detect them, and the symbol graph doesn't parse `urls.py` either. Only DRF's `@api_view`-decorated views and Django's `require_*`-decorated views get `django-endpoint` (see "Python chunking" above) — a materially bigger gap than the Express one, since it's Django's *default* style, not an edge case.
- **Symbol graph resolution is name-based, not real static analysis** — it has no type information or import-path resolution, so ambiguous same-named symbols across different files (e.g. two classes each with their own `validate` method) and calls into external/library code are both silently skipped rather than guessed at, to avoid inserting wrong edges. This means the graph is intentionally incomplete for common method/function names, and skipped ambiguities are only visible as a warning-level log line during ingestion, not surfaced through `get_symbol_context` itself.
- **GitHub tree API truncation**: `listFiles()` warns if a repo's file tree is too large for one recursive call. Very large monorepos will need directory-by-directory walking instead — not yet implemented, flagged in code. GitLab's `allRepositoryTrees()` doesn't have this truncation issue since `@gitbeaker/rest` transparently paginates through the full tree.
- **Bitbucket `max_depth` timeout risk**: Bitbucket Cloud's `src` endpoint has no single-call flat tree like GitHub's Trees API — `listFiles()` uses a bounded `max_depth` breadth-first walk (paginated via `next` links) instead. Too-large repos can return an HTTP 555 timeout, which is caught and logged as a warning rather than crashing the sync, but means very large Bitbucket repos may only get partially listed. A directory-by-directory walk would avoid this but isn't implemented yet.
- **Bitbucket Cloud only**: `BitbucketConnector` targets `api.bitbucket.org` and doesn't support self-hosted Bitbucket Data Center/Server, which uses a different API (`/rest/api/1.0/...`).
- **Embedding dimension is 1024** (truncated from `jina-code-embeddings-1.5b`'s native 1536 dims via Matryoshka representation learning, which also supports 128/256/512 if you want to trade off storage vs. quality). Change `OUTPUT_DIMENSION` in `src/embeddings/client.ts` and the `vector(1024)` column in `schema.sql` together if you adjust this.
- **Jina's free tier caps concurrent requests at 2** (`CONCURRENCY` in `src/ingest.ts`) and rate-limits to 100 RPM / 100K TPM — fine for prototyping on small repos, but large repos will take a while to fully sync without a paid key.
- **Confluence Cloud only**: `ConfluenceConnector` targets `*.atlassian.net` via the REST API v2 and doesn't support Confluence Data Center/Server, which is v1-API-only.
- **Confluence macros degrade to whatever HTML `turndown` can salvage**: interactive-widget macros (the Jira issue macro, drawio diagrams, etc.) render to non-semantic HTML in the "view" format, so their content sometimes survives as garbled text and sometimes as nothing at all — there's no macro-aware extraction.
- **Confluence images/attachments aren't fetched**: `turndown` emits `![alt](url)` for `<img>` tags, but the URL requires Confluence-session auth to actually load, so it isn't embeddable/directly usable outside the wiki.
- **No per-section Confluence deep links**: every chunk from a page points at the same whole-page `url` (`_links.webui`), not a heading-specific anchor — reconstructing Confluence's anchor-slug algorithm reliably wasn't judged worth the fragility.
- **Confluence `labels` aren't a queryable DB column yet**: they're fetched best-effort (one extra API call per page) and folded into each chunk's embedded text for retrieval purposes, but aren't a separate `chunks` column, so you can't filter search by label today — only by `sourceType`/`repo`. Would be a small additive migration if that's needed later.
