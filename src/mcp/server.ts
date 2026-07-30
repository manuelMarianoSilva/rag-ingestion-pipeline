import { fileURLToPath } from "node:url";
import path from "node:path";
import dotenv from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createDbPool } from "../db/client.js";
import { searchCode } from "../retrieval/search.js";
import { getSymbolContext, type SymbolRelationEntry } from "../retrieval/symbolContext.js";

// Resolve .env relative to this file's own location rather than
// process.cwd() -- keeps config loading correct regardless of what
// directory the MCP client actually spawns this process from.
dotenv.config({ path: path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../.env") });

// One pool shared across all tool calls for the life of the server process --
// MCP clients (e.g. Cursor) keep this process running and call tools on it
// repeatedly, so a per-call pool would leak connections.
const pool = createDbPool();

const server = new McpServer({ name: "rag-ingestion-pipeline", version: "0.1.0" });

server.registerTool(
  "search_code",
  {
    description:
      "Semantic + lexical search over ingested source code and documentation (e.g. Confluence). " +
      "Returns the most relevant functions/classes/components/doc sections matching a " +
      "natural-language question, with file path (or page title), symbol name (or heading), " +
      "and a content snippet for each result. Mixes code and docs by default -- use sourceType " +
      "to restrict to one.",
    inputSchema: {
      query: z.string().describe("Natural-language question about the codebase, e.g. 'how is BMI calculated'"),
      repo: z
        .string()
        .optional()
        .describe("Restrict results to one repo, e.g. 'owner/name'. Omit to search all ingested repos."),
      limit: z.number().int().min(1).max(20).optional().describe("Max results to return (default 10)"),
      sourceType: z
        .enum(["code", "confluence", "jira"])
        .optional()
        .describe("Restrict to one content type, e.g. 'confluence' for docs-only search. Omit to search everything."),
    },
  },
  async ({ query, repo, limit, sourceType }) => {
    try {
      const results = await searchCode(pool, query, { repo, limit, sourceType });

      if (results.length === 0) {
        return { content: [{ type: "text", text: "No matching code found." }] };
      }

      const text = results
        .map((r, i) => {
          const location = r.symbolName ? `${r.filePath} :: ${r.symbolName} (${r.symbolType})` : `${r.filePath} (whole file)`;
          const link = r.url ? `\n${r.url}` : "";
          return `${i + 1}. [score ${r.score.toFixed(4)}] ${location}${link}\n\`\`\`\n${r.displayContent}\n\`\`\``;
        })
        .join("\n\n");

      return { content: [{ type: "text", text }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `search_code failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

const RELATIONSHIP_SECTIONS: { key: keyof ReturnType<typeof sectionsOf>; label: string }[] = [
  { key: "calls", label: "Calls" },
  { key: "calledBy", label: "Called by" },
  { key: "extends", label: "Extends" },
  { key: "extendedBy", label: "Extended by" },
  { key: "implements", label: "Implements" },
  { key: "implementedBy", label: "Implemented by" },
  { key: "imports", label: "Imports" },
  { key: "importedBy", label: "Imported by" },
];

function sectionsOf(ctx: Awaited<ReturnType<typeof getSymbolContext>>) {
  return {
    calls: ctx.calls,
    calledBy: ctx.calledBy,
    extends: ctx.extends,
    extendedBy: ctx.extendedBy,
    implements: ctx.implements,
    implementedBy: ctx.implementedBy,
    imports: ctx.imports,
    importedBy: ctx.importedBy,
  };
}

function formatEntry(entry: SymbolRelationEntry): string {
  const location = `${entry.filePath} :: ${entry.symbolName}`;
  const link = entry.url ? `\n${entry.url}` : "";
  const snippet = entry.displayContent ? `\n\`\`\`\n${entry.displayContent}\n\`\`\`` : "";
  return `- ${location}${link}${snippet}`;
}

server.registerTool(
  "get_symbol_context",
  {
    description:
      "Looks up the symbol graph neighborhood of a code symbol (function/method/class/interface) within a repo: " +
      "what it calls, what calls it, what it extends/implements, and what extends/implements/imports it. " +
      "Best-effort name-based resolution -- ambiguous or external references are omitted, so an empty result " +
      "doesn't necessarily mean the symbol has no real relationships.",
    inputSchema: {
      symbolName: z
        .string()
        .describe("Symbol name to look up, e.g. 'UserController.getUser' or just 'getUser'"),
      repo: z.string().describe("Repo the symbol lives in, e.g. 'owner/name' -- same value used with search_code"),
    },
  },
  async ({ symbolName, repo }) => {
    try {
      const ctx = await getSymbolContext(pool, repo, symbolName);

      if (ctx.matchedSymbols.length === 0) {
        return {
          content: [
            { type: "text", text: `No symbol matching "${symbolName}" found in the symbol graph for ${repo}.` },
          ],
        };
      }

      const sections = sectionsOf(ctx);
      const body = RELATIONSHIP_SECTIONS.map(({ key, label }) => {
        const entries = sections[key];
        if (entries.length === 0) return "";
        return `${label}:\n${entries.map(formatEntry).join("\n")}`;
      })
        .filter(Boolean)
        .join("\n\n");

      const header = `Symbol graph for "${symbolName}" in ${repo} (matched: ${ctx.matchedSymbols.join(", ")})`;
      const text = body ? `${header}\n\n${body}` : `${header}\n\nNo recorded relationships.`;

      return { content: [{ type: "text", text }] };
    } catch (err) {
      return {
        content: [
          { type: "text", text: `get_symbol_context failed: ${err instanceof Error ? err.message : String(err)}` },
        ],
        isError: true,
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is reserved for the MCP protocol -- log readiness to stderr only.
  console.error("[mcp] rag-ingestion-pipeline server ready on stdio");
}

main().catch((err) => {
  console.error("[mcp] fatal error:", err);
  process.exit(1);
});
