/**
 * Common IR (intermediate representation).
 *
 * Every connector (GitHub, GitLab, Bitbucket, Confluence, Jira...) must
 * normalize its raw data into RawDocument before it reaches the chunker.
 * Every chunker (TypeScript, Python, Java, Markdown...) must normalize
 * its output into Chunk before it reaches the embedder.
 *
 * This is the seam that lets you add new sources/languages without
 * touching embedding, storage, or retrieval code.
 */

export type SourceType = "code" | "confluence" | "jira";

export interface RawDocument {
  sourceType: SourceType;
  sourceId: string; // e.g. "github:acme/web-app:src/components/Login.tsx"
  content: string; // raw file content
  metadata: {
    repo?: string;
    provider?: "github" | "gitlab" | "bitbucket" | "confluence";
    ref?: string; // branch or commit sha
    filePath?: string;
    language?: string;
    lastModified?: string; // ISO timestamp
    url?: string;
    labels?: string[]; // Confluence page labels, best-effort -- carried through to Chunk.metadata by the chunker
    contentHash: string; // sha256 of content, used for dedup/incremental sync
  };
}

export type SymbolType =
  | "function"
  | "class"
  | "method"
  | "component"
  | "interface"
  | "type"
  | "endpoint"
  | "section" // a heading-delimited chunk of a documentation page (e.g. Confluence)
  | "other";

export interface Chunk {
  chunkId: string; // stable id: sourceId + symbolName + startLine (hash)
  sourceType: SourceType;
  sourceId: string;
  content: string; // the text that gets embedded (may include prepended header)
  displayContent: string; // the text shown to the user/agent (may differ slightly)
  metadata: {
    repo?: string;
    filePath?: string;
    language?: string;
    symbolName?: string;
    symbolType?: SymbolType;
    startLine?: number;
    endLine?: number;
    imports?: string[]; // symbols/modules this chunk depends on
    calls?: string[]; // bare callee names referenced within this symbol's own body (receiver dropped, e.g. "findById" not "userService.findById")
    extendsSymbols?: string[]; // base class name(s)
    implementsSymbols?: string[]; // implemented interface names (Java/TS only; always empty for Python)
    exported?: boolean;
    frameworkMarkers?: string[]; // e.g. ["react-component", "react-hook", "express-route"]
    pageTitle?: string; // Confluence page title -- also reused as filePath for display purposes
    headingPath?: string[]; // full heading breadcrumb, page root -> this chunk's own heading (Confluence)
    labels?: string[]; // Confluence page labels, best-effort
    url?: string;
    lastModified?: string;
    contentHash: string;
  };
}

export interface EmbeddedChunk extends Chunk {
  embedding: number[];
}
