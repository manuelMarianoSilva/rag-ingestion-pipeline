import { chunkTypeScriptFile } from "./typescript.js";
import type { RawDocument } from "../types.js";

const sample = `
import React, { useState } from "react";
import express from "express";
import { fetchUser } from "../api/users";

interface LoginProps {
  onSuccess: (userId: string) => void;
}

/** Hook that manages login form state and submission. */
export function useLoginForm(onSuccess: (userId: string) => void) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    try {
      const user = await fetchUser(email);
      onSuccess(user.id);
    } catch (e) {
      setError("Login failed");
    }
  }

  return { email, setEmail, error, submit };
}

/** Login form component. */
export const LoginForm: React.FC<LoginProps> = ({ onSuccess }) => {
  const { email, setEmail, error, submit } = useLoginForm(onSuccess);
  return (
    <form onSubmit={submit}>
      <input value={email} onChange={(e) => setEmail(e.target.value)} />
      {error && <p>{error}</p>}
    </form>
  );
};

/** Creates a new user. Referenced by name below -- should get enriched, not duplicated. */
async function createUser(req, res) {
  const user = await db.users.create(req.body);
  res.status(201).json(user);
}

const app = express();
app.get("/users/:id", async (req, res) => {
  const user = await db.users.findById(req.params.id);
  res.json(user);
});

const router = express.Router();
router.post("/users", createUser);
`;

const doc: RawDocument = {
  sourceType: "code",
  sourceId: "github:acme/web-app:src/components/LoginForm.tsx",
  content: sample,
  metadata: {
    repo: "acme/web-app",
    provider: "github",
    ref: "main",
    filePath: "src/components/LoginForm.tsx",
    language: "typescript",
    url: "https://github.com/acme/web-app/blob/main/src/components/LoginForm.tsx",
    contentHash: "test-hash",
  },
};

const chunks = chunkTypeScriptFile(doc);

console.log(`Extracted ${chunks.length} chunks:\n`);
for (const c of chunks) {
  console.log("─".repeat(60));
  console.log(`symbol: ${c.metadata.symbolName}  type: ${c.metadata.symbolType}  exported: ${c.metadata.exported}`);
  console.log(`lines: ${c.metadata.startLine}-${c.metadata.endLine}  markers: ${c.metadata.frameworkMarkers?.join(", ")}`);
  console.log(`imports found in file: ${c.metadata.imports?.join(", ")}`);
  console.log("\n--- embedded content ---");
  console.log(c.content);
  console.log();
}
