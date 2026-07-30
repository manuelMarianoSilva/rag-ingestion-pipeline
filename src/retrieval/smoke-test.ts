import "dotenv/config";
import { createDbPool } from "../db/client.js";
import { searchCode } from "./search.js";

// Runs against whatever's already been ingested -- point REPO at a repo
// you've run `npm run ingest` against, and adjust the questions to match
// its actual content. Requires DATABASE_URL and JINA_API_KEY in .env.
const REPO = process.argv[2] ?? "GermaVinsmoke/bmi-calculator";
const QUESTIONS = [
  "how is BMI calculated",
  "where is data persisted to local storage",
  "how does the undo button work",
];

async function main() {
  const pool = createDbPool();

  for (const question of QUESTIONS) {
    console.log("=".repeat(70));
    console.log(`Q: ${question}`);
    console.log("=".repeat(70));

    const results = await searchCode(pool, question, { repo: REPO, limit: 5 });

    if (results.length === 0) {
      console.log("(no results -- has this repo been ingested? see npm run ingest)");
      continue;
    }

    for (const r of results) {
      console.log(`\n[score ${r.score.toFixed(4)}] ${r.filePath} :: ${r.symbolName ?? "(whole file)"} (${r.symbolType})`);
      console.log(r.displayContent.slice(0, 200).replace(/\n/g, " ") + (r.displayContent.length > 200 ? "..." : ""));
    }
    console.log();
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
