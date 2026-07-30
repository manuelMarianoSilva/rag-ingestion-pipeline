import Parser from "tree-sitter";
import Python from "tree-sitter-python";
import { createHash } from "node:crypto";
import type { Chunk, RawDocument, SymbolType } from "../types.js";

const pythonParser = new Parser();
pythonParser.setLanguage(Python as any);

const HTTP_METHODS = new Set(["get", "post", "put", "delete", "patch"]);

type WebFramework = "fastapi" | "flask" | "bottle";

/** Identifiers assigned via one of these calls are tracked as app/router objects
 * whose `.<verb>(path, ...)` decorators should be treated as route registrations. */
const APP_CONSTRUCTORS: Record<string, WebFramework> = {
  Flask: "flask",
  Blueprint: "flask",
  FastAPI: "fastapi",
  APIRouter: "fastapi",
  Bottle: "bottle",
};

/** Bottle also supports bare (no app-object) decorators: `@route(...)`/`@get(...)`/etc. */
const BOTTLE_BARE_DECORATOR_NAMES = new Set(["route", "get", "post", "put", "delete", "patch"]);

const DJANGO_ENDPOINT_DECORATORS = new Set(["api_view", "require_GET", "require_POST", "require_http_methods"]);

const DJANGO_MODEL_BASE_SUFFIXES = ["Model"];
const DJANGO_VIEW_BASE_SUFFIXES = ["View", "ViewSet"];
const DJANGO_SERIALIZER_BASE_SUFFIXES = ["Serializer"];

function chunkId(sourceId: string, symbolName: string, startLine: number): string {
  return createHash("sha256").update(`${sourceId}:${symbolName}:${startLine}`).digest("hex").slice(0, 24);
}

/** Unwraps a `string` node's quotes/prefix via its `string_content` child when present
 * (tree-sitter-python's newer grammar splits strings into start/content/end), falling
 * back to naive slicing for older grammar versions. */
function stringNodeValue(node: Parser.SyntaxNode): string {
  const content = node.namedChildren.find((c) => c.type === "string_content");
  return content ? content.text : node.text.slice(1, -1);
}

function listStrings(listNode: Parser.SyntaxNode): string[] {
  return listNode.namedChildren.filter((c) => c.type === "string").map(stringNodeValue);
}

function firstStringArg(args: Parser.SyntaxNode | null | undefined): string | undefined {
  const first = args?.namedChildren[0];
  return first?.type === "string" ? stringNodeValue(first) : undefined;
}

function findKeywordArg(args: Parser.SyntaxNode | null | undefined, name: string): Parser.SyntaxNode | undefined {
  return args?.namedChildren.find((c) => c.type === "keyword_argument" && c.childForFieldName("name")?.text === name);
}

/**
 * Python's equivalent of Javadoc/JSDoc, but structurally different: it isn't a
 * leading comment sibling, it's the first statement *inside* the body when that
 * statement is a bare string expression. Since it's already part of the body
 * (and therefore already part of any rawBody slice starting at the def), callers
 * that want it surfaced near the header for embedding purposes are deliberately
 * duplicating it, not pulling in new content the way the Java/TS leading-comment
 * extraction does.
 */
function getDocstring(bodyNode: Parser.SyntaxNode | null | undefined): string {
  const first = bodyNode?.namedChildren[0];
  if (first?.type === "expression_statement" && first.namedChild(0)?.type === "string") {
    return first.namedChild(0)!.text;
  }
  return "";
}

/** Collects `import`/`from ... import ...` statements as header text + a flat list of
 * imported names, plus which names were imported specifically `from bottle import ...`
 * -- needed to disambiguate Bottle's bare `@route`/`@get`/... decorators from unrelated
 * same-named functions imported from elsewhere. */
function extractImports(
  rootNode: Parser.SyntaxNode,
  source: string
): { header: string; names: string[]; bottleNames: Set<string> } {
  const importLines: string[] = [];
  const names: string[] = [];
  const bottleNames = new Set<string>();

  for (const child of rootNode.namedChildren) {
    if (child.type === "import_statement") {
      importLines.push(source.slice(child.startIndex, child.endIndex));
      for (const part of child.namedChildren) {
        if (part.type === "dotted_name") names.push(part.text.split(".").pop()!);
        else if (part.type === "aliased_import") {
          const alias = part.childForFieldName("alias");
          if (alias) names.push(alias.text);
        }
      }
    } else if (child.type === "import_from_statement") {
      importLines.push(source.slice(child.startIndex, child.endIndex));
      const moduleNameNode = child.childForFieldName("module_name");
      const isBottle = moduleNameNode?.text === "bottle";
      for (const part of child.namedChildren) {
        if (part === moduleNameNode) continue;
        if (part.type === "dotted_name") {
          names.push(part.text);
          if (isBottle) bottleNames.add(part.text);
        } else if (part.type === "aliased_import") {
          const alias = part.childForFieldName("alias");
          if (alias) names.push(alias.text);
          // Aliased bottle imports (`from bottle import get as g`) aren't tracked for
          // bare-decorator detection -- same-file aliasing of route decorators is rare
          // enough not to be worth the extra complexity.
        }
      }
    }
  }

  return { header: importLines.join("\n"), names, bottleNames };
}

/** Finds identifiers assigned via `Flask(...)`, `FastAPI(...)`, `APIRouter(...)`,
 * `Blueprint(...)`, or `Bottle(...)` -- the Python analogue of collectRouterLikeIdentifiers
 * in the TS chunker. Maps each to which framework it belongs to, since Flask/FastAPI/Bottle
 * all share the same `<app>.<verb>(path, ...)` decorator shape. */
function collectAppIdentifiers(rootNode: Parser.SyntaxNode): Map<string, WebFramework> {
  const apps = new Map<string, WebFramework>();
  for (const assignment of rootNode.descendantsOfType("assignment")) {
    const left = assignment.childForFieldName("left");
    const right = assignment.childForFieldName("right");
    if (left?.type !== "identifier" || right?.type !== "call") continue;
    const callee = right.childForFieldName("function");
    const calleeName =
      callee?.type === "identifier"
        ? callee.text
        : callee?.type === "attribute"
          ? callee.childForFieldName("attribute")?.text
          : undefined;
    const framework = calleeName ? APP_CONSTRUCTORS[calleeName] : undefined;
    if (framework) apps.set(left.text, framework);
  }
  return apps;
}

interface DecoratorEndpoint {
  marker: string; // e.g. "fastapi-endpoint"
  verbs: string[]; // e.g. ["GET"]
  path?: string; // undefined for Django, whose routes live in urls.py, not the view itself
}

/**
 * Resolves a single decorator to route info, if it matches one of:
 *  - `<app>.<verb>(path, ...)` / `<app>.route(path, methods=[...])` for a tracked
 *    Flask/FastAPI/Bottle app identifier
 *  - bare Bottle `@route(...)`/`@get(...)`/etc, gated on the name having been
 *    imported `from bottle import ...`
 *  - Django's `@api_view([...])`, `@require_GET`, `@require_POST`,
 *    `@require_http_methods([...])`, called or bare as appropriate
 */
function resolveDecorator(
  decorator: Parser.SyntaxNode,
  appIdentifiers: Map<string, WebFramework>,
  bottleNames: Set<string>
): DecoratorEndpoint | null {
  const expr = decorator.namedChild(0);
  if (!expr) return null;

  if (expr.type === "identifier" && DJANGO_ENDPOINT_DECORATORS.has(expr.text)) {
    // Bare (no-parens) form -- realistically only require_GET/require_POST are used this way.
    return { marker: "django-endpoint", verbs: [expr.text === "require_POST" ? "POST" : "GET"] };
  }

  if (expr.type !== "call") return null;
  const callee = expr.childForFieldName("function");
  const args = expr.childForFieldName("arguments");
  if (!callee) return null;

  if (callee.type === "identifier" && DJANGO_ENDPOINT_DECORATORS.has(callee.text)) {
    const firstArg = args?.namedChildren[0];
    const verbs = firstArg?.type === "list" ? listStrings(firstArg) : [];
    return { marker: "django-endpoint", verbs: verbs.length ? verbs : ["GET"] };
  }

  if (callee.type === "identifier" && bottleNames.has(callee.text) && BOTTLE_BARE_DECORATOR_NAMES.has(callee.text)) {
    const path = firstStringArg(args);
    if (callee.text === "route") {
      const methodValue = findKeywordArg(args, "method")?.childForFieldName("value");
      const verb = methodValue?.type === "string" ? stringNodeValue(methodValue).toUpperCase() : "GET";
      return { marker: "bottle-endpoint", verbs: [verb], path };
    }
    return { marker: "bottle-endpoint", verbs: [callee.text.toUpperCase()], path };
  }

  if (callee.type === "attribute") {
    const objectNode = callee.childForFieldName("object");
    const propertyNode = callee.childForFieldName("attribute");
    if (objectNode?.type !== "identifier" || !propertyNode) return null;
    const framework = appIdentifiers.get(objectNode.text);
    if (!framework) return null;

    const path = firstStringArg(args);
    const verb = propertyNode.text.toLowerCase();
    if (HTTP_METHODS.has(verb)) {
      return { marker: `${framework}-endpoint`, verbs: [verb.toUpperCase()], path };
    }
    if (verb === "route") {
      const methodsValue = findKeywordArg(args, "methods")?.childForFieldName("value");
      const verbs = methodsValue?.type === "list" ? listStrings(methodsValue).map((v) => v.toUpperCase()) : [];
      return { marker: `${framework}-endpoint`, verbs: verbs.length ? verbs : ["GET"], path };
    }
  }

  return null;
}

function resolveEndpoint(
  decorators: Parser.SyntaxNode[],
  appIdentifiers: Map<string, WebFramework>,
  bottleNames: Set<string>
): DecoratorEndpoint | null {
  for (const dec of decorators) {
    const resolved = resolveDecorator(dec, appIdentifiers, bottleNames);
    if (resolved) return resolved;
  }
  return null;
}

/**
 * Walks all `call` descendants and collects bare callee names (receiver
 * dropped, e.g. `obj.method()` yields just `method`) -- the symbol graph
 * resolver matches on trailing name segment.
 */
function collectCalleeNames(node: Parser.SyntaxNode): string[] {
  const names: string[] = [];
  for (const call of node.descendantsOfType("call")) {
    const callee = call.childForFieldName("function");
    if (!callee) continue;
    if (callee.type === "identifier") {
      names.push(callee.text);
    } else if (callee.type === "attribute") {
      const attr = callee.childForFieldName("attribute");
      if (attr) names.push(attr.text);
    }
  }
  return names;
}

/** Reads a class's base names (unqualified, e.g. `models.Model` -> `Model`) from its
 * `superclasses` field, for the Django model/view/serializer heuristics below. */
function baseClassNames(classNode: Parser.SyntaxNode): string[] {
  const superclasses = classNode.childForFieldName("superclasses");
  if (!superclasses) return [];
  return superclasses.namedChildren
    .map((c) => (c.type === "attribute" ? (c.childForFieldName("attribute")?.text ?? "") : c.text))
    .filter(Boolean);
}

function djangoClassMarkers(baseNames: string[]): string[] {
  const markers = new Set<string>();
  for (const name of baseNames) {
    if (DJANGO_MODEL_BASE_SUFFIXES.some((s) => name.endsWith(s))) markers.add("django-model");
    if (DJANGO_VIEW_BASE_SUFFIXES.some((s) => name.endsWith(s))) markers.add("django-view");
    if (DJANGO_SERIALIZER_BASE_SUFFIXES.some((s) => name.endsWith(s))) markers.add("django-serializer");
  }
  return [...markers];
}

interface ClassMember {
  node: Parser.SyntaxNode; // the function_definition itself
  decorators: Parser.SyntaxNode[]; // decorator nodes, if wrapped in a decorated_definition
}

/** Collects the method-like members directly inside a class's body -- both plain and
 * decorated (`@property`, `@api_view(...)`, etc). Deliberately does NOT descend into
 * nested class definitions, mirroring the Java chunker's top-level-types-only scope. */
function getMemberFunctions(bodyNode: Parser.SyntaxNode): ClassMember[] {
  const members: ClassMember[] = [];
  for (const child of bodyNode.namedChildren) {
    if (child.type === "function_definition") {
      members.push({ node: child, decorators: [] });
    } else if (child.type === "decorated_definition") {
      const inner = child.childForFieldName("definition");
      if (inner?.type === "function_definition") {
        members.push({ node: inner, decorators: child.namedChildren.filter((c) => c.type === "decorator") });
      }
    }
  }
  return members;
}

export function chunkPythonFile(doc: RawDocument): Chunk[] {
  // node-tree-sitter's string parse() defaults to a 32KB internal buffer and
  // throws a bare "Invalid argument" for any input at or above that size --
  // https://github.com/tree-sitter/node-tree-sitter/issues/199. Sizing the
  // buffer to the actual input means this scales to any file size.
  const tree = pythonParser.parse(doc.content, undefined, { bufferSize: doc.content.length + 1 });
  const root = tree.rootNode;

  const { header: importHeader, names: importedNames, bottleNames } = extractImports(root, doc.content);
  const appIdentifiers = collectAppIdentifiers(root);
  const chunks: Chunk[] = [];

  function pushFunctionChunk(
    fnNode: Parser.SyntaxNode,
    decorators: Parser.SyntaxNode[],
    symbolName: string,
    classSignature?: string,
    classMarkers: string[] = [],
    classExtends: string[] = []
  ): void {
    const nameNode = fnNode.childForFieldName("name");
    if (!nameNode) return;

    const calls = collectCalleeNames(fnNode);

    const endpoint = resolveEndpoint(decorators, appIdentifiers, bottleNames);
    const symbolType: SymbolType = endpoint ? "endpoint" : classSignature ? "method" : "function";
    const frameworkMarkers = endpoint ? [...classMarkers, endpoint.marker] : classMarkers;
    const routeLabel = endpoint
      ? endpoint.path
        ? `${endpoint.verbs.join("/")} ${endpoint.path}`
        : endpoint.verbs.join("/")
      : undefined;

    // Include decorator lines in the chunk body -- they're siblings of fnNode under
    // decorated_definition, not children of it, so fnNode's own range excludes them.
    // A node's startIndex excludes its leading indentation, so for indented methods
    // (decorator or `def` starting mid-line) prepend it back for a readable first line.
    const startNode = decorators.length > 0 ? decorators[0] : fnNode;
    const rawBody = " ".repeat(startNode.startPosition.column) + doc.content.slice(startNode.startIndex, fnNode.endIndex);
    const startLine = startNode.startPosition.row + 1;
    const endLine = fnNode.endPosition.row + 1;
    // Deliberately duplicated near the header (see getDocstring's comment) so it
    // survives even if a very long function body gets truncated by the embedder.
    const docstring = getDocstring(fnNode.childForFieldName("body"));

    const embeddedText = [
      `File: ${doc.metadata.filePath}`,
      routeLabel ? `Route: ${routeLabel}` : "",
      importHeader ? `Imports:\n${importHeader}` : "",
      classSignature ? `Class: ${classSignature}` : "",
      docstring,
      rawBody,
    ]
      .filter(Boolean)
      .join("\n\n");

    chunks.push({
      chunkId: chunkId(doc.sourceId, symbolName, startLine),
      sourceType: "code",
      sourceId: doc.sourceId,
      content: embeddedText,
      displayContent: rawBody,
      metadata: {
        repo: doc.metadata.repo,
        filePath: doc.metadata.filePath,
        language: doc.metadata.language,
        symbolName,
        symbolType,
        startLine,
        endLine,
        imports: importedNames,
        calls,
        extendsSymbols: classExtends,
        implementsSymbols: [],
        exported: !nameNode.text.startsWith("_"),
        frameworkMarkers,
        url: doc.metadata.url ? `${doc.metadata.url}#L${startLine}-L${endLine}` : undefined,
        lastModified: doc.metadata.lastModified,
        contentHash: doc.metadata.contentHash,
      },
    });
  }

  for (const stmt of root.namedChildren) {
    let node = stmt;
    let decorators: Parser.SyntaxNode[] = [];

    if (stmt.type === "decorated_definition") {
      const inner = stmt.childForFieldName("definition");
      if (!inner) continue;
      node = inner;
      decorators = stmt.namedChildren.filter((c) => c.type === "decorator");
    }

    if (node.type === "function_definition") {
      const nameNode = node.childForFieldName("name");
      if (!nameNode) continue;
      pushFunctionChunk(node, decorators, nameNode.text);
      continue;
    }

    if (node.type !== "class_definition") continue;

    const nameNode = node.childForFieldName("name");
    const bodyNode = node.childForFieldName("body");
    if (!nameNode || !bodyNode) continue;

    const className = nameNode.text;
    const baseNames = baseClassNames(node);
    const classMarkers = djangoClassMarkers(baseNames);
    const classSignature = doc.content.slice(node.startIndex, bodyNode.startIndex).trim();
    const members = getMemberFunctions(bodyNode);

    if (members.length === 0) {
      // No methods (Django models with only field assignments, dataclass-style
      // classes, marker classes) -- chunk the whole class, mirroring Java's DTO fallback.
      const startLine = node.startPosition.row + 1;
      const endLine = node.endPosition.row + 1;
      const rawBody = doc.content.slice(node.startIndex, node.endIndex);
      const calls = collectCalleeNames(node);

      const embeddedText = [
        `File: ${doc.metadata.filePath}`,
        importHeader ? `Imports:\n${importHeader}` : "",
        rawBody,
      ]
        .filter(Boolean)
        .join("\n\n");

      chunks.push({
        chunkId: chunkId(doc.sourceId, className, startLine),
        sourceType: "code",
        sourceId: doc.sourceId,
        content: embeddedText,
        displayContent: rawBody,
        metadata: {
          repo: doc.metadata.repo,
          filePath: doc.metadata.filePath,
          language: doc.metadata.language,
          symbolName: className,
          symbolType: "class",
          startLine,
          endLine,
          imports: importedNames,
          calls,
          extendsSymbols: baseNames,
          implementsSymbols: [],
          exported: !className.startsWith("_"),
          frameworkMarkers: classMarkers,
          url: doc.metadata.url ? `${doc.metadata.url}#L${startLine}-L${endLine}` : undefined,
          lastModified: doc.metadata.lastModified,
          contentHash: doc.metadata.contentHash,
        },
      });
      continue;
    }

    for (const member of members) {
      const methodNameNode = member.node.childForFieldName("name");
      const methodName = methodNameNode?.text ?? "unknown";
      pushFunctionChunk(member.node, member.decorators, `${className}.${methodName}`, classSignature, classMarkers, baseNames);
    }
  }

  // Fallback: files with no top-level function/class definitions at all (pure
  // scripts/constants modules) still get indexed as a single whole-file chunk,
  // mirroring both the Java and TS chunkers' defensive fallback.
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
