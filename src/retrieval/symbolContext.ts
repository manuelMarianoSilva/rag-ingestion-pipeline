import pg from "pg";

export interface SymbolRelationEntry {
  symbol: string; // fully-qualified, e.g. "acme/web-app:src/UserController.ts:UserController.getUser"
  filePath: string;
  symbolName: string;
  displayContent?: string; // short snippet, when the target chunk is still indexed
  url?: string;
}

export interface SymbolContext {
  repo: string;
  symbolName: string;
  matchedSymbols: string[]; // fully-qualified symbols in `repo` whose trailing name matched `symbolName`
  calls: SymbolRelationEntry[];
  calledBy: SymbolRelationEntry[];
  extends: SymbolRelationEntry[];
  extendedBy: SymbolRelationEntry[];
  implements: SymbolRelationEntry[];
  implementedBy: SymbolRelationEntry[];
  imports: SymbolRelationEntry[];
  importedBy: SymbolRelationEntry[];
}

type Relationship = "imports" | "calls" | "extends" | "implements";

interface EdgeRow {
  from_symbol: string;
  to_symbol: string;
  relationship: Relationship;
}

const OUTGOING_BUCKET: Record<Relationship, keyof SymbolContext> = {
  imports: "imports",
  calls: "calls",
  extends: "extends",
  implements: "implements",
};

const INCOMING_BUCKET: Record<Relationship, keyof SymbolContext> = {
  imports: "importedBy",
  calls: "calledBy",
  extends: "extendedBy",
  implements: "implementedBy",
};

/** Escapes LIKE metacharacters in the symbol name before anchoring it to the trailing `:symbolName` segment of a fully-qualified symbol id. */
function likePattern(symbolName: string): string {
  const escaped = symbolName.replace(/[\\%_]/g, (c) => `\\${c}`);
  return `%:${escaped}`;
}

/** Splits `repo:filePath:symbolName` back into parts -- relies on `repo`/`filePath` never containing a colon, true for every connector in this codebase today. */
function parseFqSymbol(fq: string): { filePath: string; symbolName: string } {
  const firstColon = fq.indexOf(":");
  const lastColon = fq.lastIndexOf(":");
  return {
    filePath: fq.slice(firstColon + 1, lastColon),
    symbolName: fq.slice(lastColon + 1),
  };
}

const SNIPPET_MAX_CHARS = 400;

/**
 * Looks up the symbol graph neighborhood of `symbolName` within `repo`:
 * everything it calls/extends/implements/imports, and everything that
 * calls/extends/implements/imports it -- resolved via the best-effort name
 * matching `populateSymbolGraph` already did at ingest time. Returns empty
 * buckets (not an error) when the symbol has no recorded edges.
 */
export async function getSymbolContext(pool: pg.Pool, repo: string, symbolName: string): Promise<SymbolContext> {
  const pattern = likePattern(symbolName);
  const edgeRes = await pool.query<EdgeRow>(
    `SELECT from_symbol, to_symbol, relationship
     FROM symbol_edges
     WHERE repo = $1 AND (from_symbol LIKE $2 ESCAPE '\\' OR to_symbol LIKE $2 ESCAPE '\\')`,
    [repo, pattern]
  );

  const matchedSymbols = new Set<string>();
  const buckets: Record<Exclude<keyof SymbolContext, "repo" | "symbolName" | "matchedSymbols">, SymbolRelationEntry[]> = {
    calls: [],
    calledBy: [],
    extends: [],
    extendedBy: [],
    implements: [],
    implementedBy: [],
    imports: [],
    importedBy: [],
  };

  const isMatch = (fq: string) => fq.endsWith(`:${symbolName}`);

  for (const row of edgeRes.rows) {
    if (isMatch(row.from_symbol)) {
      matchedSymbols.add(row.from_symbol);
      const target = parseFqSymbol(row.to_symbol);
      buckets[OUTGOING_BUCKET[row.relationship] as keyof typeof buckets].push({ symbol: row.to_symbol, ...target });
    }
    if (isMatch(row.to_symbol)) {
      matchedSymbols.add(row.to_symbol);
      const source = parseFqSymbol(row.from_symbol);
      buckets[INCOMING_BUCKET[row.relationship] as keyof typeof buckets].push({ symbol: row.from_symbol, ...source });
    }
  }

  const allEntries = Object.values(buckets).flat();
  if (allEntries.length > 0) {
    const symbolNames = [...new Set(allEntries.map((e) => e.symbolName))];
    const chunkRes = await pool.query<{ symbol_name: string; file_path: string | null; display_content: string; url: string | null }>(
      `SELECT symbol_name, file_path, display_content, url FROM chunks WHERE repo = $1 AND symbol_name = ANY($2::text[])`,
      [repo, symbolNames]
    );
    const bySymbol = new Map<string, { display_content: string; url: string | null }>();
    for (const row of chunkRes.rows) {
      // Keyed by symbolName + filePath since symbolName alone isn't unique across files.
      bySymbol.set(`${row.file_path ?? ""}\u0000${row.symbol_name}`, row);
    }
    for (const entry of allEntries) {
      const chunk = bySymbol.get(`${entry.filePath}\u0000${entry.symbolName}`);
      if (chunk) {
        entry.displayContent =
          chunk.display_content.length > SNIPPET_MAX_CHARS
            ? chunk.display_content.slice(0, SNIPPET_MAX_CHARS) + "\n..."
            : chunk.display_content;
        entry.url = chunk.url ?? undefined;
      }
    }
  }

  return { repo, symbolName, matchedSymbols: [...matchedSymbols], ...buckets };
}
