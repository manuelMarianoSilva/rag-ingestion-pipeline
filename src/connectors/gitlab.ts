import { Gitlab } from "@gitbeaker/rest";
import type { RawDocument } from "../types.js";
import { hashContent, isIngestible, languageForPath } from "./shared.js";

export interface GitlabSyncTarget {
  // URL-encoded-able path like "group/subgroup/project" -- GitLab supports
  // arbitrarily nested groups, unlike GitHub's flat owner/repo.
  projectPath: string;
  ref?: string; // branch or sha; defaults to project's default branch
}

export class GitlabConnector {
  private api: Gitlab<false>;

  constructor(authToken: string, host?: string) {
    this.api = new Gitlab<false>({
      token: authToken,
      host: host ?? process.env.GITLAB_HOST ?? "https://gitlab.com",
    });
  }

  /**
   * Lists all ingestible file paths in a project at a given ref.
   * Uses the Repositories tree API with recursive:true -- gitbeaker
   * transparently walks GitLab's offset pagination and returns the full
   * flattened tree in one call.
   */
  async listFiles(target: GitlabSyncTarget): Promise<string[]> {
    const ref = target.ref ?? (await this.getDefaultBranch(target));
    const tree = await this.api.Repositories.allRepositoryTrees(target.projectPath, {
      ref,
      recursive: true,
    });

    return tree
      .filter((entry) => entry.type === "blob" && entry.path && isIngestible(entry.path))
      .map((entry) => entry.path);
  }

  private async getDefaultBranch(target: GitlabSyncTarget): Promise<string> {
    const project = await this.api.Projects.show(target.projectPath);
    return project.default_branch ?? "main";
  }

  /**
   * Fetches a single file's content and normalizes it into a RawDocument.
   * GitLab's raw-file endpoint returns plain text directly, no base64
   * decoding needed unlike GitHub's contents API.
   */
  async fetchFile(target: GitlabSyncTarget, path: string): Promise<RawDocument | null> {
    const ref = target.ref ?? (await this.getDefaultBranch(target));
    const raw = await this.api.RepositoryFiles.showRaw(target.projectPath, path, ref);

    if (typeof raw !== "string") {
      // Shouldn't happen given the extension filter, but binary/oversized
      // files should fail soft rather than crash the whole sync.
      return null;
    }

    const content = raw;
    const language = languageForPath(path);
    const host = process.env.GITLAB_HOST ?? "https://gitlab.com";

    return {
      sourceType: "code",
      sourceId: `gitlab:${target.projectPath}:${path}`,
      content,
      metadata: {
        repo: target.projectPath,
        provider: "gitlab",
        ref,
        filePath: path,
        language,
        url: `${host}/${target.projectPath}/-/blob/${ref}/${path}`,
        contentHash: hashContent(content),
      },
    };
  }

  /**
   * Given a webhook push payload's list of changed files, returns just
   * those paths -- for incremental sync instead of re-walking the whole tree.
   * Mirrors GithubConnector's method; GitLab push-event webhooks carry a
   * similar commits[].added/modified/removed shape.
   */
  filterChangedIngestibleFiles(changedPaths: string[]): string[] {
    return changedPaths.filter(isIngestible);
  }
}
