import { resolveSymbolEdges, type ChunkRecord } from "./populate.js";

const REPO = "acme/web-app";

// Hand-built chunk records covering the four resolution outcomes the plan calls out:
//  1. A resolvable same-file call edge (getUser -> findById, unambiguous).
//  2. A resolvable extends edge (AdminController -> BaseController).
//  3. An ambiguous call (two files both define `.validate`) -- correctly skipped.
//  4. An unresolvable import (external package `react`) -- correctly skipped.
const records: ChunkRecord[] = [
  {
    filePath: "src/UserController.ts",
    symbolName: "UserController.getUser",
    imports: ["react"], // external package -- zero candidates, must be skipped
    calls: ["findById"], // resolves to UserService.findById via trailing-segment match
    extendsSymbols: [],
    implementsSymbols: [],
  },
  {
    filePath: "src/UserService.ts",
    symbolName: "UserService.findById",
    imports: [],
    calls: ["validate"], // ambiguous -- two candidates below -- must be skipped
    extendsSymbols: [],
    implementsSymbols: [],
  },
  {
    filePath: "src/BaseController.ts",
    symbolName: "BaseController",
    imports: [],
    calls: [],
    extendsSymbols: [],
    implementsSymbols: [],
  },
  {
    filePath: "src/AdminController.ts",
    symbolName: "AdminController",
    imports: [],
    calls: [],
    extendsSymbols: ["BaseController"], // resolves unambiguously
    implementsSymbols: [],
  },
  {
    filePath: "src/FormValidator.ts",
    symbolName: "FormValidator.validate",
    imports: [],
    calls: [],
    extendsSymbols: [],
    implementsSymbols: [],
  },
  {
    filePath: "src/UserValidator.ts",
    symbolName: "UserValidator.validate",
    imports: [],
    calls: [],
    extendsSymbols: [],
    implementsSymbols: [],
  },
];

const edges = resolveSymbolEdges(REPO, records);

console.log(`Resolved ${edges.length} edge(s):\n`);
for (const edge of edges) {
  console.log(`  ${edge.fromSymbol} --[${edge.relationship}]--> ${edge.toSymbol}`);
}

console.log("\nExpected: exactly 2 edges (getUser -[calls]-> findById, AdminController -[extends]-> BaseController).");
console.log("The 'react' import and the ambiguous 'validate' call should be silently skipped (with a warning logged for the latter).");

const hasCallEdge = edges.some(
  (e) => e.relationship === "calls" && e.fromSymbol.endsWith("UserController.getUser") && e.toSymbol.endsWith("UserService.findById")
);
const hasExtendsEdge = edges.some(
  (e) => e.relationship === "extends" && e.fromSymbol.endsWith("AdminController") && e.toSymbol.endsWith("BaseController")
);
const hasNoReactEdge = !edges.some((e) => e.toSymbol.includes("react"));
const hasNoValidateEdge = !edges.some((e) => e.toSymbol.endsWith(".validate"));

console.log(`\ncalls edge present: ${hasCallEdge}`);
console.log(`extends edge present: ${hasExtendsEdge}`);
console.log(`react import correctly skipped: ${hasNoReactEdge}`);
console.log(`ambiguous validate call correctly skipped: ${hasNoValidateEdge}`);

const allPassed = hasCallEdge && hasExtendsEdge && hasNoReactEdge && hasNoValidateEdge && edges.length === 2;
console.log(`\n${allPassed ? "PASS" : "FAIL"}`);
if (!allPassed) process.exit(1);
