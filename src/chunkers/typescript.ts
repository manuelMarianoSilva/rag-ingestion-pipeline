import Parser from "tree-sitter";
// tree-sitter-typescript exports two grammars: .typescript (.ts) and .tsx (.tsx)
import TypeScriptLang from "tree-sitter-typescript";
import { createHash } from "node:crypto";
import type { Chunk, RawDocument, SymbolType } from "../types.js";

const tsParser = new Parser();
tsParser.setLanguage(TypeScriptLang.typescript as any);

const tsxParser = new Parser();
tsxParser.setLanguage(TypeScriptLang.tsx as any);

function chunkId(sourceId: string, symbolName: string, startLine: number): string {
  return createHash("sha256").update(`${sourceId}:${symbolName}:${startLine}`).digest("hex").slice(0, 24);
}

function isPascalCase(name: string): boolean {
  return /^[A-Z][A-Za-z0-9]*$/.test(name);
}

function isHookName(name: string): boolean {
  return /^use[A-Z]/.test(name);
}

const HTTP_METHODS = new Set(["get", "post", "put", "delete", "patch", "all"]);

/**
 * Name heuristic for Express/Fastify/koa-router-style app/router identifiers,
 * used when there's no local `express()`/`.Router()` assignment to track
 * (e.g. a router passed in as a function parameter in a modular route file).
 */
function isRouterLikeName(name: string): boolean {
  return /^(app|router)$/i.test(name) || /Router$/.test(name) || /App$/.test(name);
}

/** Finds identifiers assigned via `express()` or `<expr>.Router()` anywhere in the file. */
function collectRouterLikeIdentifiers(rootNode: Parser.SyntaxNode): Set<string> {
  const names = new Set<string>();
  for (const decl of rootNode.descendantsOfType("variable_declarator")) {
    const nameNode = decl.childForFieldName("name");
    const valueNode = decl.childForFieldName("value");
    if (!nameNode || valueNode?.type !== "call_expression") continue;
    const callee = valueNode.childForFieldName("function");
    const isExpressCall = callee?.type === "identifier" && callee.text === "express";
    const isRouterCall = callee?.type === "member_expression" && callee.childForFieldName("property")?.text === "Router";
    if (isExpressCall || isRouterCall) names.add(nameNode.text);
  }
  return names;
}

interface RouteCall {
  statementNode: Parser.SyntaxNode;
  method: string; // uppercase HTTP verb
  path: string;
  handlerNode: Parser.SyntaxNode; // last call argument
}

/**
 * Scans top-level expression statements for `<router>.<verb>(path, ...handlers)`
 * calls -- the shape Express/Fastify/koa-router route registrations take.
 * Detection is shape-based (not import-verified), so it will also catch
 * structurally-identical Fastify/koa-router code -- treated as a feature,
 * not a false positive, since the goal is "this looks like an HTTP route."
 */
function extractRouteCalls(rootNode: Parser.SyntaxNode, routerNames: Set<string>): RouteCall[] {
  const routes: RouteCall[] = [];
  for (const stmt of rootNode.namedChildren) {
    if (stmt.type !== "expression_statement") continue;
    const call = stmt.namedChildren[0];
    if (call?.type !== "call_expression") continue;
    const callee = call.childForFieldName("function");
    if (callee?.type !== "member_expression") continue;
    const objectNode = callee.childForFieldName("object");
    const propertyNode = callee.childForFieldName("property");
    if (objectNode?.type !== "identifier" || !propertyNode) continue;
    const method = propertyNode.text.toLowerCase();
    if (!HTTP_METHODS.has(method)) continue;
    if (!routerNames.has(objectNode.text) && !isRouterLikeName(objectNode.text)) continue;

    const args = call.childForFieldName("arguments");
    const firstArg = args?.namedChildren[0];
    if (!firstArg || !["string", "template_string"].includes(firstArg.type)) continue;
    const path = firstArg.text.slice(1, -1); // strip quotes -- best-effort, fine for display/matching
    if (!path.startsWith("/")) continue;

    const handlerNode = args!.namedChildren[args!.namedChildren.length - 1];
    if (handlerNode) routes.push({ statementNode: stmt, method: method.toUpperCase(), path, handlerNode });
  }
  return routes;
}

/**
 * Walks all `call_expression` descendants of a symbol's body and collects bare
 * callee names -- receiver dropped (e.g. `userService.findById()` yields just
 * `findById`), since the symbol graph resolver matches on trailing name segment.
 */
function collectCalleeNames(node: Parser.SyntaxNode): string[] {
  const names: string[] = [];
  for (const call of node.descendantsOfType("call_expression")) {
    const callee = call.childForFieldName("function");
    if (!callee) continue;
    if (callee.type === "identifier") {
      names.push(callee.text);
    } else if (callee.type === "member_expression") {
      const property = callee.childForFieldName("property");
      if (property) names.push(property.text);
    }
  }
  return names;
}

/** Reads a class's `extends`/`implements` clauses (the `class_heritage` node) into name arrays. */
function collectHeritage(classNode: Parser.SyntaxNode): { extendsSymbols: string[]; implementsSymbols: string[] } {
  const extendsSymbols: string[] = [];
  const implementsSymbols: string[] = [];
  const heritage = classNode.namedChildren.find((c) => c.type === "class_heritage");
  if (heritage) {
    const extendsClause = heritage.namedChildren.find((c) => c.type === "extends_clause");
    const baseExpr = extendsClause?.namedChildren[0];
    if (baseExpr) extendsSymbols.push(baseExpr.text);

    const implementsClause = heritage.namedChildren.find((c) => c.type === "implements_clause");
    if (implementsClause) {
      for (const type of implementsClause.namedChildren) {
        // Generic interfaces (e.g. `Repository<User>`) wrap the name in a generic_type node.
        const nameNode = type.type === "generic_type" ? type.childForFieldName("name") : type;
        if (nameNode) implementsSymbols.push(nameNode.text);
      }
    }
  }
  return { extendsSymbols, implementsSymbols };
}

/** Extracts the leading JSDoc/comment block immediately above a node, if any. */
function getLeadingComment(node: Parser.SyntaxNode, source: string): string {
  let prev = node.previousNamedSibling;
  if (prev && (prev.type === "comment")) {
    return source.slice(prev.startIndex, prev.endIndex);
  }
  return "";
}

/** Collects top-level import statements as a single header block + a list of imported names. */
function extractImports(rootNode: Parser.SyntaxNode, source: string): { header: string; names: string[] } {
  const importLines: string[] = [];
  const names: string[] = [];

  for (const child of rootNode.namedChildren) {
    if (child.type === "import_statement") {
      importLines.push(source.slice(child.startIndex, child.endIndex));
      // Best-effort extraction of imported identifiers for the symbol graph later.
      const importClause = child.namedChildren.find((c) => c.type === "import_clause");
      if (importClause) {
        for (const named of importClause.descendantsOfType(["identifier"])) {
          names.push(named.text);
        }
      }
    }
  }

  return { header: importLines.join("\n"), names };
}

interface ExtractedSymbol {
  name: string;
  symbolType: SymbolType;
  node: Parser.SyntaxNode; // the declaration itself -- used for body text extraction
  topLevelNode: Parser.SyntaxNode; // the statement as it appears at file top level (may be the
  // export_statement wrapper) -- comments precede THIS node, not the unwrapped inner declaration
  exported: boolean;
  frameworkMarkers: string[];
  routeLabel?: string; // e.g. "GET /users" -- set when an Express-style route call was matched to this symbol
}

/**
 * Walks top-level statements and pulls out chunkable declarations.
 * Deliberately chunks at the TOP level only (function/class/component/type) --
 * not nested closures -- since those are rarely meaningful retrieval units
 * on their own and would just add noise.
 */
function extractSymbols(rootNode: Parser.SyntaxNode): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];

  for (const stmt of rootNode.namedChildren) {
    let node = stmt;
    let exported = false;

    if (stmt.type === "export_statement") {
      exported = true;
      const inner = stmt.namedChildren.find((c) => c.type !== "export_clause");
      if (!inner) continue;
      node = inner;
    }

    switch (node.type) {
      case "function_declaration": {
        const nameNode = node.childForFieldName("name");
        if (!nameNode) break;
        const name = nameNode.text;
        const markers: string[] = [];
        if (isPascalCase(name)) markers.push("react-component");
        if (isHookName(name)) markers.push("react-hook");
        symbols.push({
          name,
          symbolType: isPascalCase(name) ? "component" : "function",
          node,
          topLevelNode: stmt,
          exported,
          frameworkMarkers: markers,
        });
        break;
      }

      case "class_declaration": {
        const nameNode = node.childForFieldName("name");
        if (!nameNode) break;
        symbols.push({
          name: nameNode.text,
          symbolType: "class",
          node,
          topLevelNode: stmt,
          exported,
          frameworkMarkers: [],
        });
        break;
      }

      case "interface_declaration": {
        const nameNode = node.childForFieldName("name");
        if (!nameNode) break;
        symbols.push({
          name: nameNode.text,
          symbolType: "interface",
          node,
          topLevelNode: stmt,
          exported,
          frameworkMarkers: [],
        });
        break;
      }

      case "type_alias_declaration": {
        const nameNode = node.childForFieldName("name");
        if (!nameNode) break;
        symbols.push({
          name: nameNode.text,
          symbolType: "type",
          node,
          topLevelNode: stmt,
          exported,
          frameworkMarkers: [],
        });
        break;
      }

      case "lexical_declaration": {
        // Covers: const Foo = () => {...}, const useThing = () => {...}
        for (const declarator of node.namedChildren) {
          if (declarator.type !== "variable_declarator") continue;
          const nameNode = declarator.childForFieldName("name");
          const valueNode = declarator.childForFieldName("value");
          if (!nameNode || !valueNode) continue;
          if (!["arrow_function", "function_expression"].includes(valueNode.type)) continue;

          const name = nameNode.text;
          const markers: string[] = [];
          if (isPascalCase(name)) markers.push("react-component");
          if (isHookName(name)) markers.push("react-hook");

          symbols.push({
            name,
            symbolType: isPascalCase(name) ? "component" : "function",
            node, // keep the whole `const X = ...` statement, not just the arrow fn
            topLevelNode: stmt,
            exported,
            frameworkMarkers: markers,
          });
        }
        break;
      }

      default:
        break; // statements we don't chunk individually (e.g. bare expressions)
    }
  }

  // Express/Fastify/koa-router-style route registrations (`app.get('/x', handler)`)
  // are bare expression statements, so they were skipped entirely by the switch
  // above. Reconcile them now: if the handler is a reference to a symbol we
  // already extracted (a named function/const declared in this file), enrich
  // that chunk in place rather than emitting a redundant near-empty second
  // chunk -- mirrors how Java's method chunks carry their own annotations
  // directly. Otherwise (inline handler, or a reference we can't resolve
  // locally) emit a dedicated chunk for the route statement so it isn't lost.
  const routerNames = collectRouterLikeIdentifiers(rootNode);
  for (const route of extractRouteCalls(rootNode, routerNames)) {
    const routeLabel = `${route.method} ${route.path}`;
    const handlerName = route.handlerNode.type === "identifier" ? route.handlerNode.text : null;
    const existing = handlerName ? symbols.find((s) => s.name === handlerName) : undefined;

    if (existing) {
      existing.symbolType = "endpoint";
      if (!existing.frameworkMarkers.includes("express-route")) existing.frameworkMarkers.push("express-route");
      existing.routeLabel = routeLabel;
    } else {
      symbols.push({
        name: routeLabel,
        symbolType: "endpoint",
        node: route.statementNode,
        topLevelNode: route.statementNode,
        exported: false,
        frameworkMarkers: ["express-route"],
      });
    }
  }

  return symbols;
}

export function chunkTypeScriptFile(doc: RawDocument): Chunk[] {
  const isTsx = doc.metadata.filePath?.endsWith(".tsx") ?? false;
  const parser = isTsx ? tsxParser : tsParser;
  // node-tree-sitter's string parse() defaults to a 32KB internal buffer and
  // throws a bare "Invalid argument" for any input at or above that size --
  // https://github.com/tree-sitter/node-tree-sitter/issues/199. Sizing the
  // buffer to the actual input means this scales to any file size.
  const tree = parser.parse(doc.content, undefined, { bufferSize: doc.content.length + 1 });
  const root = tree.rootNode;

  const { header: importHeader, names: importedNames } = extractImports(root, doc.content);
  const symbols = extractSymbols(root);
  const chunks: Chunk[] = [];

  for (const sym of symbols) {
    const rawBody = doc.content.slice(sym.node.startIndex, sym.node.endIndex);
    const leadingComment = getLeadingComment(sym.topLevelNode, doc.content);
    const startLine = sym.node.startPosition.row + 1;
    const endLine = sym.node.endPosition.row + 1;
    const calls = collectCalleeNames(sym.node);
    const heritage = sym.node.type === "class_declaration"
      ? collectHeritage(sym.node)
      : { extendsSymbols: [], implementsSymbols: [] };

    // Embedded text = enough header context (file path, relevant imports, doc comment)
    // + the symbol body. This is what gets embedded, so the vector captures
    // "what is this" not just raw syntax. The route label (when present) surfaces
    // the HTTP method + path even for symbols enriched via an Express route call
    // rather than chunked from the route statement itself.
    const embeddedText = [
      `File: ${doc.metadata.filePath}`,
      sym.routeLabel ? `Route: ${sym.routeLabel}` : "",
      importHeader ? `Imports:\n${importHeader}` : "",
      leadingComment,
      rawBody,
    ]
      .filter(Boolean)
      .join("\n\n");

    chunks.push({
      chunkId: chunkId(doc.sourceId, sym.name, startLine),
      sourceType: "code",
      sourceId: doc.sourceId,
      content: embeddedText,
      displayContent: (leadingComment ? leadingComment + "\n" : "") + rawBody,
      metadata: {
        repo: doc.metadata.repo,
        filePath: doc.metadata.filePath,
        language: doc.metadata.language,
        symbolName: sym.name,
        symbolType: sym.symbolType,
        startLine,
        endLine,
        imports: importedNames,
        calls,
        extendsSymbols: heritage.extendsSymbols,
        implementsSymbols: heritage.implementsSymbols,
        exported: sym.exported,
        frameworkMarkers: sym.frameworkMarkers,
        url: doc.metadata.url ? `${doc.metadata.url}#L${startLine}-L${endLine}` : undefined,
        lastModified: doc.metadata.lastModified,
        contentHash: doc.metadata.contentHash,
      },
    });
  }

  // Fallback: files with no top-level chunkable symbols (e.g. a pure
  // constants file, or a barrel `export * from './x'` file) still get
  // indexed as a single whole-file chunk so they're not silently dropped.
  if (chunks.length === 0) {
    chunks.push({
      chunkId: chunkId(doc.sourceId, "__file__", 1),
      sourceType: "code",
      sourceId: doc.sourceId,
      content: `File: ${doc.metadata.filePath}\n\n${doc.content}`,
      displayContent: doc.content,
      metadata: {
        repo: doc.metadata.repo,
        filePath: doc.metadata.filePath,
        language: doc.metadata.language,
        symbolType: "other",
        startLine: 1,
        endLine: doc.content.split("\n").length,
        imports: importedNames,
        exported: false,
        frameworkMarkers: [],
        url: doc.metadata.url,
        lastModified: doc.metadata.lastModified,
        contentHash: doc.metadata.contentHash,
      },
    });
  }

  return chunks;
}
