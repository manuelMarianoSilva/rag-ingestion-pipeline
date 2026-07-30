import { createHash } from "node:crypto";
import type { Chunk, RawDocument } from "../types.js";

// A section whose own body is shorter than this is considered heading-only
// noise (e.g. a heading immediately followed by subheadings) and isn't
// emitted as its own chunk -- it still contributes to descendants' breadcrumbs.
const MIN_SECTION_CHARS = 40;
// Sections longer than this are split into overlapping windows so they stay
// embedder-friendly, mirroring why code chunkers split per-function/method.
const MAX_SECTION_CHARS = 6000;
const WINDOW_OVERLAP_CHARS = 500;

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;

function chunkId(sourceId: string, symbolName: string, startLine: number): string {
  return createHash("sha256").update(`${sourceId}:${symbolName}:${startLine}`).digest("hex").slice(0, 24);
}

interface Section {
  level: number; // 0 for the pre-first-heading intro segment
  heading: string; // "" for the intro segment
  headingPath: string[]; // breadcrumb including this section's own heading (empty for intro)
  startLine: number;
  endLine: number;
  bodyLines: string[];
}

/**
 * Builds a heading-tree from Markdown by walking it line by line, tracking a
 * stack of open headings by level (1-6): a heading of level L closes every
 * open section with level >= L, then opens itself. A section's "own body" is
 * only the text directly under it, up to (not including) the very next
 * heading of any level -- nested subsections' text belongs to them, not to
 * their ancestor.
 *
 * Deliberately ignores `#` characters inside fenced code blocks so code
 * comments like `# TODO` in a fenced snippet aren't mistaken for headings.
 */
function parseSections(content: string): Section[] {
  const lines = content.split("\n");
  const sections: Section[] = [];
  const stack: { level: number; text: string }[] = [];
  let inFence = false;

  let current: Section = {
    level: 0,
    heading: "",
    headingPath: [],
    startLine: 1,
    endLine: lines.length,
    bodyLines: [],
  };

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;

    if (/^```/.test(line.trim())) {
      inFence = !inFence;
      current.bodyLines.push(line);
      return;
    }

    const match = inFence ? null : HEADING_RE.exec(line);
    if (!match) {
      current.bodyLines.push(line);
      return;
    }

    current.endLine = lineNo - 1;
    sections.push(current);

    const level = match[1].length;
    const headingText = match[2].trim();
    while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
    const headingPath = [...stack.map((s) => s.text), headingText];
    stack.push({ level, text: headingText });

    current = { level, heading: headingText, headingPath, startLine: lineNo, endLine: lines.length, bodyLines: [] };
  });

  sections.push(current);
  return sections;
}

/** Splits an oversized section body into fixed-size overlapping windows. Returns a single-element array unchanged if it already fits. */
function splitOversizedBody(body: string): string[] {
  if (body.length <= MAX_SECTION_CHARS) return [body];

  const windows: string[] = [];
  let start = 0;
  while (start < body.length) {
    const end = Math.min(start + MAX_SECTION_CHARS, body.length);
    windows.push(body.slice(start, end));
    if (end === body.length) break;
    start = end - WINDOW_OVERLAP_CHARS;
  }
  return windows;
}

/**
 * Chunks a Confluence page (already converted to Markdown by
 * ConfluenceConnector) by heading hierarchy -- the doc-equivalent of the
 * code chunkers' tree-sitter AST boundaries. Falls back to a single
 * whole-page chunk when the page has no headings at all.
 */
export function chunkConfluencePage(doc: RawDocument): Chunk[] {
  const pageTitle = doc.metadata.filePath ?? "(untitled)";
  const labels = doc.metadata.labels ?? [];
  const sections = parseSections(doc.content);
  const hasHeadings = sections.some((s) => s.level > 0);

  function buildChunk(
    symbolName: string,
    headingPath: string[],
    startLine: number,
    endLine: number,
    body: string
  ): Chunk {
    const embeddedText = [
      `Page: ${pageTitle}`,
      headingPath.length ? `Section: ${headingPath.join(" > ")}` : "",
      labels.length ? `Labels: ${labels.join(", ")}` : "",
      body,
    ]
      .filter(Boolean)
      .join("\n\n");

    return {
      chunkId: chunkId(doc.sourceId, symbolName, startLine),
      sourceType: "confluence",
      sourceId: doc.sourceId,
      content: embeddedText,
      displayContent: body,
      metadata: {
        repo: doc.metadata.repo,
        filePath: pageTitle,
        symbolName,
        symbolType: "section",
        startLine,
        endLine,
        pageTitle,
        headingPath,
        labels,
        // No per-section deep links -- reconstructing Confluence's anchor-slug
        // algorithm reliably isn't worth the fragility, so every chunk from a
        // page points at the same whole-page URL.
        url: doc.metadata.url,
        lastModified: doc.metadata.lastModified,
        contentHash: doc.metadata.contentHash,
      },
    };
  }

  if (!hasHeadings) {
    const body = doc.content.trim();
    return [buildChunk("(page)", [], 1, Math.max(doc.content.split("\n").length, 1), body)];
  }

  const chunks: Chunk[] = [];
  for (const section of sections) {
    const body = section.bodyLines.join("\n").trim();
    if (body.length < MIN_SECTION_CHARS) continue;

    const symbolName = section.level === 0 ? "(intro)" : section.heading;
    const windows = splitOversizedBody(body);

    if (windows.length === 1) {
      chunks.push(buildChunk(symbolName, section.headingPath, section.startLine, section.endLine, body));
    } else {
      windows.forEach((window, i) => {
        chunks.push(
          buildChunk(`${symbolName} (part ${i + 1})`, section.headingPath, section.startLine, section.endLine, window)
        );
      });
    }
  }

  return chunks;
}
