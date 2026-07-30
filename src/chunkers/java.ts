import Parser from "tree-sitter";
import Java from "tree-sitter-java";
import { createHash } from "node:crypto";
import type { Chunk, RawDocument, SymbolType } from "../types.js";

const javaParser = new Parser();
javaParser.setLanguage(Java as any);

/** Java type declarations that can appear at the top level of a file. */
const TYPE_DECLARATION_TYPES = new Set([
  "class_declaration",
  "interface_declaration",
  "enum_declaration",
  "record_declaration",
]);

/** Method-like member declarations chunked individually within a type. */
const MEMBER_DECLARATION_TYPES = new Set([
  "method_declaration",
  "constructor_declaration",
  "compact_constructor_declaration", // record compact constructors
]);

/** Class/interface-level annotations that map to a framework marker. */
const CLASS_ANNOTATION_MARKERS: Record<string, string> = {
  RestController: "spring-controller",
  Controller: "spring-controller",
  Service: "spring-service",
  Repository: "spring-repository",
  Component: "spring-component",
  Entity: "jpa-entity",
};

/** Method-level annotations that mark a Spring MVC/WebFlux HTTP endpoint. */
const ENDPOINT_ANNOTATIONS = new Set([
  "GetMapping",
  "PostMapping",
  "PutMapping",
  "DeleteMapping",
  "PatchMapping",
  "RequestMapping",
]);

function chunkId(sourceId: string, symbolName: string, startLine: number): string {
  return createHash("sha256").update(`${sourceId}:${symbolName}:${startLine}`).digest("hex").slice(0, 24);
}

/** Extracts the leading Javadoc/comment block immediately above a node, if any. */
function getLeadingComment(node: Parser.SyntaxNode, source: string): string {
  const prev = node.previousNamedSibling;
  if (prev && prev.type === "block_comment") {
    return source.slice(prev.startIndex, prev.endIndex);
  }
  return "";
}

/** Reads the annotation names (unqualified) attached to a declaration's `modifiers` child, if any. */
function getAnnotationNames(node: Parser.SyntaxNode): string[] {
  const modifiers = node.namedChildren.find((c) => c.type === "modifiers");
  if (!modifiers) return [];
  return modifiers.namedChildren
    .filter((c) => c.type === "marker_annotation" || c.type === "annotation")
    .map((c) => c.namedChild(0)?.text ?? "")
    .filter(Boolean);
}

/** Whether a declaration's modifiers explicitly include `private` (package-private/public/protected all count as "exported" here). */
function isPrivate(node: Parser.SyntaxNode): boolean {
  const modifiers = node.namedChildren.find((c) => c.type === "modifiers");
  if (!modifiers) return false;
  // `public`/`private`/etc keywords are anonymous tokens, so fall back to raw text.
  return /\bprivate\b/.test(modifiers.text);
}

function classFrameworkMarkers(annotationNames: string[]): string[] {
  const markers = new Set<string>();
  for (const name of annotationNames) {
    const marker = CLASS_ANNOTATION_MARKERS[name];
    if (marker) markers.add(marker);
  }
  return [...markers];
}

function isEndpointAnnotated(annotationNames: string[]): boolean {
  return annotationNames.some((name) => ENDPOINT_ANNOTATIONS.has(name));
}

/**
 * Walks all `method_invocation` descendants and collects bare method names
 * (receiver dropped, e.g. `someUtil.process()` yields just `process`) --
 * the symbol graph resolver matches on trailing name segment.
 */
function collectCalleeNames(node: Parser.SyntaxNode): string[] {
  const names: string[] = [];
  for (const call of node.descendantsOfType("method_invocation")) {
    const nameNode = call.childForFieldName("name");
    if (nameNode) names.push(nameNode.text);
  }
  return names;
}

/** Reads a class declaration's `extends`/`implements` clauses into name arrays (generic args stripped). */
function classHeritage(typeNode: Parser.SyntaxNode): { extendsSymbols: string[]; implementsSymbols: string[] } {
  const extendsSymbols: string[] = [];
  const implementsSymbols: string[] = [];

  const superclassNode = typeNode.childForFieldName("superclass");
  const superType = superclassNode?.namedChildren[0];
  if (superType) extendsSymbols.push(superType.text.split("<")[0]);

  const interfacesNode = typeNode.childForFieldName("interfaces");
  const typeList = interfacesNode?.namedChildren.find((c) => c.type === "type_list");
  if (typeList) {
    for (const t of typeList.namedChildren) implementsSymbols.push(t.text.split("<")[0]);
  }

  return { extendsSymbols, implementsSymbols };
}

/** Collects `package` + `import` declarations as header text + a flat list of imported names. */
function extractPackageAndImports(
  rootNode: Parser.SyntaxNode,
  source: string,
): { packageName: string; importHeader: string; names: string[] } {
  let packageName = "";
  const importLines: string[] = [];
  const names: string[] = [];

  for (const child of rootNode.namedChildren) {
    if (child.type === "package_declaration") {
      const scoped = child.namedChildren.find((c) => c.type !== ";");
      packageName = scoped ? scoped.text : "";
    } else if (child.type === "import_declaration") {
      importLines.push(source.slice(child.startIndex, child.endIndex));
      const isWildcard = child.namedChildren.some((c) => c.type === "asterisk");
      if (!isWildcard) {
        const path = child.namedChildren.find((c) => c.type === "scoped_identifier" || c.type === "identifier");
        if (path) {
          const segments = path.text.split(".");
          names.push(segments[segments.length - 1]);
        }
      }
    }
  }

  return { packageName, importHeader: importLines.join("\n"), names };
}

/**
 * Collects the method-like members directly inside a type's body, unwrapping
 * the one extra level of nesting `enum_body_declarations` adds for enum methods.
 * Deliberately does NOT descend into nested/inner type declarations -- those
 * are out of scope (this chunker only handles top-level types).
 */
function getMemberDeclarations(bodyNode: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const members: Parser.SyntaxNode[] = [];
  for (const child of bodyNode.namedChildren) {
    if (MEMBER_DECLARATION_TYPES.has(child.type)) {
      members.push(child);
    } else if (child.type === "enum_body_declarations") {
      for (const inner of child.namedChildren) {
        if (MEMBER_DECLARATION_TYPES.has(inner.type)) members.push(inner);
      }
    }
  }
  return members;
}

function typeSymbolType(nodeType: string): SymbolType {
  return nodeType === "interface_declaration" ? "interface" : "class";
}

export function chunkJavaFile(doc: RawDocument): Chunk[] {
  // node-tree-sitter's string parse() defaults to a 32KB internal buffer and
  // throws a bare "Invalid argument" for any input at or above that size --
  // https://github.com/tree-sitter/node-tree-sitter/issues/199. Sizing the
  // buffer to the actual input means this scales to any file size.
  const tree = javaParser.parse(doc.content, undefined, { bufferSize: doc.content.length + 1 });
  const root = tree.rootNode;

  const { packageName, importHeader, names: importedNames } = extractPackageAndImports(root, doc.content);
  const packageLine = packageName ? `package ${packageName};` : "";

  const chunks: Chunk[] = [];

  for (const typeNode of root.namedChildren) {
    if (!TYPE_DECLARATION_TYPES.has(typeNode.type)) continue;

    const nameNode = typeNode.childForFieldName("name");
    const bodyNode = typeNode.childForFieldName("body");
    if (!nameNode || !bodyNode) continue;

    const className = nameNode.text;
    const classAnnotationNames = getAnnotationNames(typeNode);
    const classMarkers = classFrameworkMarkers(classAnnotationNames);
    const classLeadingComment = getLeadingComment(typeNode, doc.content);
    // Signature line(s): everything from the start of the declaration (including
    // its annotations, which are a child of this node) up to the opening `{`.
    const classSignature = doc.content.slice(typeNode.startIndex, bodyNode.startIndex).trim();
    const heritage = typeNode.type === "class_declaration"
      ? classHeritage(typeNode)
      : { extendsSymbols: [], implementsSymbols: [] };

    const members = getMemberDeclarations(bodyNode);

    if (members.length === 0) {
      // No methods/constructors (DTO, marker interface, plain enum) -- chunk the whole type.
      const startLine = typeNode.startPosition.row + 1;
      const endLine = typeNode.endPosition.row + 1;
      const rawBody = doc.content.slice(typeNode.startIndex, typeNode.endIndex);
      const calls = collectCalleeNames(typeNode);

      const embeddedText = [
        `File: ${doc.metadata.filePath}`,
        packageLine,
        importHeader ? `Imports:\n${importHeader}` : "",
        classLeadingComment,
        rawBody,
      ]
        .filter(Boolean)
        .join("\n\n");

      chunks.push({
        chunkId: chunkId(doc.sourceId, className, startLine),
        sourceType: "code",
        sourceId: doc.sourceId,
        content: embeddedText,
        displayContent: (classLeadingComment ? classLeadingComment + "\n" : "") + rawBody,
        metadata: {
          repo: doc.metadata.repo,
          filePath: doc.metadata.filePath,
          language: doc.metadata.language,
          symbolName: className,
          symbolType: typeSymbolType(typeNode.type),
          startLine,
          endLine,
          imports: importedNames,
          calls,
          extendsSymbols: heritage.extendsSymbols,
          implementsSymbols: heritage.implementsSymbols,
          exported: !isPrivate(typeNode),
          frameworkMarkers: classMarkers,
          url: doc.metadata.url ? `${doc.metadata.url}#L${startLine}-L${endLine}` : undefined,
          lastModified: doc.metadata.lastModified,
          contentHash: doc.metadata.contentHash,
        },
      });
      continue;
    }

    for (const member of members) {
      const isCtor = member.type === "constructor_declaration" || member.type === "compact_constructor_declaration";
      const methodNameNode = member.childForFieldName("name");
      const methodName = isCtor ? className : (methodNameNode?.text ?? "unknown");
      const symbolName = `${className}.${methodName}`;

      const methodAnnotationNames = getAnnotationNames(member);
      const endpoint = !isCtor && isEndpointAnnotated(methodAnnotationNames);
      const symbolType: SymbolType = endpoint ? "endpoint" : "method";
      const frameworkMarkers = endpoint ? [...classMarkers, "spring-endpoint"] : classMarkers;

      const methodLeadingComment = getLeadingComment(member, doc.content);
      const rawBody = doc.content.slice(member.startIndex, member.endIndex);
      const startLine = member.startPosition.row + 1;
      const endLine = member.endPosition.row + 1;
      const calls = collectCalleeNames(member);

      // Embedded text = package + imports + class signature (with class-level
      // annotations) + method Javadoc + method body. Gives the embedding model
      // class context without pulling in the whole class body for every method.
      const embeddedText = [
        `File: ${doc.metadata.filePath}`,
        packageLine,
        importHeader ? `Imports:\n${importHeader}` : "",
        `Class: ${classSignature}`,
        methodLeadingComment,
        rawBody,
      ]
        .filter(Boolean)
        .join("\n\n");

      chunks.push({
        chunkId: chunkId(doc.sourceId, symbolName, startLine),
        sourceType: "code",
        sourceId: doc.sourceId,
        content: embeddedText,
        displayContent: (methodLeadingComment ? methodLeadingComment + "\n" : "") + rawBody,
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
          extendsSymbols: heritage.extendsSymbols,
          implementsSymbols: heritage.implementsSymbols,
          exported: !isPrivate(member),
          frameworkMarkers,
          url: doc.metadata.url ? `${doc.metadata.url}#L${startLine}-L${endLine}` : undefined,
          lastModified: doc.metadata.lastModified,
          contentHash: doc.metadata.contentHash,
        },
      });
    }
  }

  // Fallback: no top-level type declarations at all (shouldn't normally happen
  // for valid Java, but mirrors the TS chunker's defensive whole-file fallback).
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
