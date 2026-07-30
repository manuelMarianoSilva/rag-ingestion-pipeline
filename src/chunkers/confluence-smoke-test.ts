import { chunkConfluencePage } from "./confluence.js";
import type { RawDocument } from "../types.js";

// Deliberately built past MAX_SECTION_CHARS (6000) so the fixed-window
// fallback in confluence.ts kicks in. At exactly 13000 chars with a 6000-char
// window / 500-char overlap, the split lands on 3 windows: [0,6000),
// [5500,11500), [11000,13000) -- see splitOversizedBody's loop.
const filler = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ";
const oversizedBody = filler.repeat(Math.ceil(13000 / filler.length)).slice(0, 13000);

// Post-turndown-conversion Markdown (as ConfluenceConnector would hand it to
// the chunker) -- no real HTML/turndown needed for this test.
const sample = `This page describes how the deployment pipeline works end to end, from a
merged pull request to a running production instance.

# Deployment

## Rollback Procedure

If a deploy goes bad, use the rollback runbook: revert the merge commit,
re-run the release pipeline against the previous tag, and notify #incidents.

## Oversized Section

${oversizedBody}

# FAQ

Q: Who owns the pipeline? A: The Platform team, see #platform-oncall.
`;

const doc: RawDocument = {
  sourceType: "confluence",
  sourceId: "confluence:ENG:123456",
  content: sample,
  metadata: {
    repo: "ENG",
    provider: "confluence",
    filePath: "Deployment Guide",
    url: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123456/Deployment+Guide",
    lastModified: "2026-01-01T00:00:00.000Z",
    labels: ["runbook", "platform"],
    contentHash: "test-hash",
  },
};

const chunks = chunkConfluencePage(doc);

console.log(`Extracted ${chunks.length} chunks:\n`);
for (const c of chunks) {
  console.log("─".repeat(60));
  console.log(`symbol: ${c.metadata.symbolName}  heading path: [${c.metadata.headingPath?.join(" > ")}]`);
  console.log(`lines: ${c.metadata.startLine}-${c.metadata.endLine}  length: ${c.displayContent.length}`);
}
console.log();

const introChunk = chunks.find((c) => c.metadata.symbolName === "(intro)");
const deploymentOwnChunk = chunks.find((c) => c.metadata.symbolName === "Deployment");
const rollbackChunk = chunks.find((c) => c.metadata.symbolName === "Rollback Procedure");
const oversizedParts = chunks.filter((c) => c.metadata.symbolName?.startsWith("Oversized Section (part "));
const faqChunk = chunks.find((c) => c.metadata.symbolName === "FAQ");

const hasIntro = introChunk !== undefined && introChunk.metadata.headingPath?.length === 0;
const deploymentHasNoOwnChunk = deploymentOwnChunk === undefined; // heading-only, empty own body -- shouldn't be emitted
const rollbackHasCorrectBreadcrumb =
  rollbackChunk !== undefined &&
  JSON.stringify(rollbackChunk.metadata.headingPath) === JSON.stringify(["Deployment", "Rollback Procedure"]);
const oversizedSplitCorrectly = oversizedParts.length === 3;
const faqHasCorrectBreadcrumb =
  faqChunk !== undefined && JSON.stringify(faqChunk.metadata.headingPath) === JSON.stringify(["FAQ"]);
const allChunksAreSections = chunks.every((c) => c.metadata.symbolType === "section");
const allChunksCarryPageMetadata = chunks.every(
  (c) => c.metadata.pageTitle === "Deployment Guide" && c.metadata.labels?.join(",") === "runbook,platform"
);

console.log(`intro chunk present (empty breadcrumb): ${hasIntro}`);
console.log(`"Deployment" heading-only section correctly skipped: ${deploymentHasNoOwnChunk}`);
console.log(`"Rollback Procedure" breadcrumb correct: ${rollbackHasCorrectBreadcrumb}`);
console.log(`oversized section split into 3 windows: ${oversizedSplitCorrectly}`);
console.log(`"FAQ" breadcrumb correct: ${faqHasCorrectBreadcrumb}`);
console.log(`every chunk is symbolType "section": ${allChunksAreSections}`);
console.log(`every chunk carries pageTitle/labels: ${allChunksCarryPageMetadata}`);

const allPassed =
  hasIntro &&
  deploymentHasNoOwnChunk &&
  rollbackHasCorrectBreadcrumb &&
  oversizedSplitCorrectly &&
  faqHasCorrectBreadcrumb &&
  allChunksAreSections &&
  allChunksCarryPageMetadata;

console.log(`\n${allPassed ? "PASS" : "FAIL"}`);
if (!allPassed) process.exit(1);
