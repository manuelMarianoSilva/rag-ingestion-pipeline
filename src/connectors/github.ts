import { Octokit } from "@octokit/rest";
import type { RawDocument } from "../types.js";
import { hashContent, isIngestible, languageForPath } from "./shared.js";

export interface GithubSyncTarget {
  owner: string;
  repo: string;
  ref?: string; // branch or sha; defaults to repo's default branch
}

export class GithubConnector {
  private octokit: Octokit;

  constructor(authToken: string) {
    this.octokit = new Octokit({ auth: authToken });
  }

  /**
   * Lists all ingestible file paths in a repo at a given ref.
   * Uses the Git Trees API with recursive=1 -- one call for the whole tree
   * rather than walking directories one by one.
   */
  async listFiles(target: GithubSyncTarget): Promise<string[]> {
    const ref = target.ref ?? (await this.getDefaultBranch(target));
    const { data } = await this.octokit.git.getTree({
      owner: target.owner,
      repo: target.repo,
      tree_sha: ref,
      recursive: "true",
    });

    if (data.truncated) {
      // Repo is large enough that the recursive tree got truncated.
      // At that scale, switch to walking directories incrementally
      // (contents API) instead of one flat recursive call.
      console.warn(
        `[github] tree truncated for ${target.owner}/${target.repo} -- consider directory-by-directory walk`
      );
    }

    return (data.tree ?? [])
      .filter((entry) => entry.type === "blob" && entry.path && isIngestible(entry.path))
      .map((entry) => entry.path!) ;
  }

  private async getDefaultBranch(target: GithubSyncTarget): Promise<string> {
    const { data } = await this.octokit.repos.get({
      owner: target.owner,
      repo: target.repo,
    });
    return data.default_branch;
  }

  /**
   * Fetches a single file's content and normalizes it into a RawDocument.
   * Returns null for files that can't be decoded as text (shouldn't happen
   * given the extension filter, but binary/oversized files should fail soft).
   */
  async fetchFile(
    target: GithubSyncTarget,
    path: string
  ): Promise<RawDocument | null> {
    const ref = target.ref ?? (await this.getDefaultBranch(target));
    const { data } = await this.octokit.repos.getContent({
      owner: target.owner,
      repo: target.repo,
      path,
      ref,
    });

    if (Array.isArray(data) || data.type !== "file" || !("content" in data)) {
      return null;
    }

    const content = Buffer.from(data.content, "base64").toString("utf-8");
    const language = languageForPath(path);

    return {
      sourceType: "code",
      sourceId: `github:${target.owner}/${target.repo}:${path}`,
      content,
      metadata: {
        repo: `${target.owner}/${target.repo}`,
        provider: "github",
        ref,
        filePath: path,
        language,
        url: `https://github.com/${target.owner}/${target.repo}/blob/${ref}/${path}`,
        contentHash: hashContent(content),
      },
    };
  }

  /**
   * Given a webhook push payload's list of changed files, returns just
   * those paths -- for incremental sync instead of re-walking the whole tree.
   */
  filterChangedIngestibleFiles(changedPaths: string[]): string[] {
    return changedPaths.filter(isIngestible);
  }
}
