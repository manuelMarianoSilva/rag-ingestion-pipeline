import type { RawDocument } from "../types.js";
import { hashContent, isIngestible, languageForPath } from "./shared.js";

const API_BASE = "https://api.bitbucket.org/2.0";

// Bitbucket's src listing endpoint isn't recursive by default -- max_depth
// makes it walk subdirectories breadth-first in one call chain (still
// paginated via `next`). Too large a value on a huge repo can time out
// with a 555; see README known limitations, same category as GitHub's
// tree-truncation warning.
const MAX_DEPTH = 25;
const PAGE_LEN = 100;

export interface BitbucketSyncTarget {
  workspace: string;
  repoSlug: string;
  ref?: string; // branch or commit; defaults to repo's main branch
}

interface BitbucketTreeEntry {
  type: "commit_file" | "commit_directory";
  path: string;
}

interface BitbucketPaginatedResponse {
  values: BitbucketTreeEntry[];
  next?: string;
}

export class BitbucketConnector {
  private authHeader?: string;

  /**
   * Bitbucket Cloud has two incompatible credential shapes that both end up
   * in `BITBUCKET_TOKEN`, so we accept an optional email to disambiguate:
   *  - `email` + `token` -> personal Atlassian API token (replaced App
   *    Passwords as of July 2026) -- these are Basic-auth only, i.e.
   *    `email:token` base64-encoded. Bearer auth on these always 401s.
   *  - `token` alone -> Repository/Workspace/Project Access Token, which
   *    *is* Bearer-compatible (this is what the old code assumed).
   *  - neither -> anonymous, which still works for public repos.
   */
  constructor(token?: string, email?: string) {
    if (token && email) {
      this.authHeader = `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
    } else if (token) {
      this.authHeader = `Bearer ${token}`;
    }
  }

  private async request(url: string): Promise<Response> {
    return fetch(url, {
      headers: this.authHeader ? { Authorization: this.authHeader } : {},
    });
  }

  private async getDefaultBranch(target: BitbucketSyncTarget): Promise<string> {
    const res = await this.request(
      `${API_BASE}/repositories/${target.workspace}/${target.repoSlug}`
    );
    if (!res.ok) {
      throw new Error(
        `[bitbucket] failed to fetch repo ${target.workspace}/${target.repoSlug}: ${res.status} ${res.statusText}`
      );
    }
    const data = await res.json();
    return data.mainbranch?.name ?? "main";
  }

  /**
   * Lists all ingestible file paths in a repo at a given ref.
   * Bitbucket's src endpoint only has a `max_depth` recursive walk (still
   * paginated) rather than GitHub's single flat recursive-tree call --
   * follow `next` links until the whole (bounded-depth) tree is collected.
   */
  async listFiles(target: BitbucketSyncTarget): Promise<string[]> {
    const ref = target.ref ?? (await this.getDefaultBranch(target));
    const paths: string[] = [];

    let url: string | undefined =
      `${API_BASE}/repositories/${target.workspace}/${target.repoSlug}/src/${ref}/` +
      `?max_depth=${MAX_DEPTH}&pagelen=${PAGE_LEN}`;

    while (url) {
      const res: Response = await this.request(url);
      if (!res.ok) {
        throw new Error(
          `[bitbucket] failed to list files for ${target.workspace}/${target.repoSlug}: ${res.status} ${res.statusText}`
        );
      }
      if (res.status === 555) {
        console.warn(
          `[bitbucket] max_depth=${MAX_DEPTH} timed out for ${target.workspace}/${target.repoSlug} -- consider a directory-by-directory walk for very large repos`
        );
        break;
      }

      const data: BitbucketPaginatedResponse = await res.json();
      for (const entry of data.values) {
        if (entry.type === "commit_file" && isIngestible(entry.path)) {
          paths.push(entry.path);
        }
      }
      url = data.next;
    }

    return paths;
  }

  /**
   * Fetches a single file's content and normalizes it into a RawDocument.
   * Bitbucket's src/{ref}/{path} endpoint returns raw file bytes directly
   * (no base64 decoding needed, like GitLab's raw-file endpoint).
   */
  async fetchFile(target: BitbucketSyncTarget, path: string): Promise<RawDocument | null> {
    const ref = target.ref ?? (await this.getDefaultBranch(target));
    const res = await this.request(
      `${API_BASE}/repositories/${target.workspace}/${target.repoSlug}/src/${ref}/${path}`
    );

    if (!res.ok) {
      // Fail soft -- shouldn't happen given the extension filter, but
      // binary/oversized/missing files shouldn't crash the whole sync.
      return null;
    }

    const content = await res.text();
    const language = languageForPath(path);

    return {
      sourceType: "code",
      sourceId: `bitbucket:${target.workspace}/${target.repoSlug}:${path}`,
      content,
      metadata: {
        repo: `${target.workspace}/${target.repoSlug}`,
        provider: "bitbucket",
        ref,
        filePath: path,
        language,
        url: `https://bitbucket.org/${target.workspace}/${target.repoSlug}/src/${ref}/${path}`,
        contentHash: hashContent(content),
      },
    };
  }

  /**
   * Given a webhook push payload's list of changed files, returns just
   * those paths -- for incremental sync instead of re-walking the whole tree.
   * Mirrors GithubConnector/GitlabConnector's method.
   */
  filterChangedIngestibleFiles(changedPaths: string[]): string[] {
    return changedPaths.filter(isIngestible);
  }
}
