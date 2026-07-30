import type pg from "pg";

/** The subset of a chunk's stored metadata the resolver needs -- deliberately
 * decoupled from the DB row shape so `resolveSymbolEdges` stays pure/testable. */
export interface ChunkRecord {
  filePath: string;
  symbolName: string;
  imports: string[];
  calls: string[];
  extendsSymbols: string[];
  implementsSymbols: string[];
}

export type SymbolRelationship = "imports" | "calls" | "extends" | "implements";

export interface SymbolEdge {
  fromSymbol: string;
  toSymbol: string;
  relationship: SymbolRelationship;
}

/** Fully-qualified symbol id stored in `symbol_edges.from_symbol`/`to_symbol`. */
function fqSymbol(repo: string, filePath: string, symbolName: string): string {
  return `${repo}:${filePath}:${symbolName}`;
}

/**
 * Indexes every chunk's symbolName in the repo, plus a secondary index keyed
 * by the trailing segment after the last `.` -- a method chunk named
 * `UserController.getUser` is reachable both by its full name and by
 * `getUser`, since callee names/heritage never include the receiver/qualifier.
 */
function buildNameIndex(repo: string, records: ChunkRecord[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  const add = (name: string, fq: string) => {
    if (!index.has(name)) index.set(name, new Set());
    index.get(name)!.add(fq);
  };

  for (const record of records) {
    if (!record.symbolName) continue;
    const fq = fqSymbol(repo, record.filePath, record.symbolName);
    add(record.symbolName, fq);
    const lastSegment = record.symbolName.split(".").pop()!;
    if (lastSegment !== record.symbolName) add(lastSegment, fq);
  }

  return index;
}

/**
 * Resolves a referenced name to exactly one same-repo symbol. Zero candidates
 * (import of an external package, call into a library) and multiple
 * candidates (two files both define e.g. a `validate` function) are both
 * skipped rather than guessed -- see the plan's rationale. A symbol can never
 * resolve to itself (guards against e.g. a recursive call producing a
 * self-loop edge).
 */
function resolveName(name: string, index: Map<string, Set<string>>, fromSymbol: string): string | null {
  const candidates = index.get(name);
  if (!candidates || candidates.size === 0) return null;

  const filtered = [...candidates].filter((c) => c !== fromSymbol);
  if (filtered.length === 0) return null;
  if (filtered.length > 1) {
    console.warn(
      `[symbol-graph] ambiguous reference "${name}" from ${fromSymbol}: ${filtered.length} candidates, skipping`
    );
    return null;
  }
  return filtered[0];
}

/**
 * Pure, DB-free resolution of name references (imports/calls/extends/implements)
 * into concrete symbol_edges rows, for a single repo's worth of chunks.
 * Dedupes by (fromSymbol, toSymbol, relationship) since Java/Python's
 * class-level heritage data is repeated across every method chunk of the
 * same class.
 */
export function resolveSymbolEdges(repo: string, records: ChunkRecord[]): SymbolEdge[] {
  const index = buildNameIndex(repo, records);
  const edgeKeys = new Set<string>();
  const edges: SymbolEdge[] = [];

  const addEdge = (fromSymbol: string, toSymbol: string, relationship: SymbolRelationship) => {
    const key = `${fromSymbol}\u0000${toSymbol}\u0000${relationship}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ fromSymbol, toSymbol, relationship });
  };

  for (const record of records) {
    if (!record.symbolName) continue;
    const fromSymbol = fqSymbol(repo, record.filePath, record.symbolName);

    const byRelationship: [string[], SymbolRelationship][] = [
      [record.imports, "imports"],
      [record.calls, "calls"],
      [record.extendsSymbols, "extends"],
      [record.implementsSymbols, "implements"],
    ];

    for (const [names, relationship] of byRelationship) {
      for (const name of names) {
        const toSymbol = resolveName(name, index, fromSymbol);
        if (toSymbol) addEdge(fromSymbol, toSymbol, relationship);
      }
    }
  }

  return edges;
}

/**
 * DB-wired wrapper: reads every chunk for `repo`, resolves edges, and does a
 * full rebuild of that repo's `symbol_edges` rows (delete + batch insert).
 * Full rebuild rather than incremental -- cheap since it's pure DB read +
 * name matching, no embedding calls -- so there's no staleness to reconcile.
 */
export async function populateSymbolGraph(pool: pg.Pool, repo: string): Promise<void> {
  const res = await pool.query<{
    file_path: string | null;
    symbol_name: string | null;
    imports: string[] | null;
    calls: string[] | null;
    extends_symbols: string[] | null;
    implements_symbols: string[] | null;
  }>(
    `SELECT file_path, symbol_name, imports, calls, extends_symbols, implements_symbols
     FROM chunks
     WHERE repo = $1 AND symbol_name IS NOT NULL`,
    [repo]
  );

  const records: ChunkRecord[] = res.rows.map((row) => ({
    filePath: row.file_path ?? "",
    symbolName: row.symbol_name ?? "",
    imports: row.imports ?? [],
    calls: row.calls ?? [],
    extendsSymbols: row.extends_symbols ?? [],
    implementsSymbols: row.implements_symbols ?? [],
  }));

  const edges = resolveSymbolEdges(repo, records);

  await pool.query(`DELETE FROM symbol_edges WHERE repo = $1`, [repo]);

  if (edges.length === 0) {
    console.log(`[symbol-graph] ${repo}: no resolvable edges`);
    return;
  }

  await pool.query(
    `INSERT INTO symbol_edges (repo, from_symbol, to_symbol, relationship)
     SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[]) AS t(from_symbol, to_symbol, relationship)`,
    [repo, edges.map((e) => e.fromSymbol), edges.map((e) => e.toSymbol), edges.map((e) => e.relationship)]
  );

  console.log(`[symbol-graph] ${repo}: inserted ${edges.length} edge(s)`);
}
