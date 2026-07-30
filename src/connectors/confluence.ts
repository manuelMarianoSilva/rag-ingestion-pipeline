import TurndownService from "turndown";
import type { RawDocument } from "../types.js";
import { hashContent } from "./shared.js";

const PAGE_LIMIT = 100;

const turndown = new TurndownService({ headingStyle: "atx" });

export interface ConfluenceSyncTarget {
  spaceKey: string;
}

interface PageInfo {
  title: string;
  parentId: string | null;
}

interface ConfluenceSpace {
  id: string;
  key: string;
}

interface ConfluencePageSummary {
  id: string;
  title: string;
  status: string;
  parentId: string | null;
}

interface ConfluencePaginatedResponse<T> {
  results: T[];
  _links?: { next?: string };
}

interface ConfluencePageDetail {
  id: string;
  title: string;
  version?: { createdAt?: string };
  body?: { view?: { value?: string } };
  _links?: { webui?: string };
}

/**
 * Confluence Cloud, REST API v2 (`/wiki/api/v2/...`) only -- Server/Data
 * Center use a different (v1-only) API and aren't supported here.
 */
export class ConfluenceConnector {
  private authHeader?: string;
  private origin: string;
  private apiBase: string;
  // spaceKey -> numeric space id, resolved once per key.
  private spaceIdCache = new Map<string, string>();
  // page id -> {title, parentId}, populated by listFiles and reused by
  // fetchFile to build a page-ancestry breadcrumb without extra API calls.
  private pageInfoCache = new Map<string, PageInfo>();

  /**
   * Confluence Cloud's only authenticated path is Basic `email:token` auth
   * with a personal Atlassian API token (same scheme as Bitbucket's
   * email+token path in BitbucketConnector). email/token are optional --
   * omit both for anonymous read access to spaces with anonymous access
   * enabled (mirrors BitbucketConnector's anonymous fallback). Sending a
   * blank/malformed Basic header instead of omitting it entirely actively
   * breaks anonymous access (Confluence 401s on it), so the header is only
   * set when real credentials are provided.
   */
  constructor(
    private readonly baseUrl: string,
    email?: string,
    token?: string
  ) {
    if (email && token) {
      this.authHeader = `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
    }
    this.origin = new URL(baseUrl).origin;
    this.apiBase = `${baseUrl}/api/v2`;
  }

  private async request(url: string): Promise<Response> {
    return fetch(url, {
      headers: {
        ...(this.authHeader ? { Authorization: this.authHeader } : {}),
        Accept: "application/json",
      },
    });
  }

  private async resolveSpaceId(spaceKey: string): Promise<string> {
    const cached = this.spaceIdCache.get(spaceKey);
    if (cached) return cached;

    const res = await this.request(`${this.apiBase}/spaces?keys=${encodeURIComponent(spaceKey)}`);
    if (!res.ok) {
      throw new Error(`[confluence] failed to resolve space ${spaceKey}: ${res.status} ${res.statusText}`);
    }
    const data: ConfluencePaginatedResponse<ConfluenceSpace> = await res.json();
    const space = data.results[0];
    if (!space) {
      throw new Error(`[confluence] space not found: ${spaceKey}`);
    }
    this.spaceIdCache.set(spaceKey, space.id);
    return space.id;
  }

  /**
   * Lists all current (non-archived/trashed) page ids in a space, cursor
   * paginated via `_links.next` (a path relative to the site root, unlike
   * Bitbucket's `next` which is already a full URL).
   */
  async listFiles(target: ConfluenceSyncTarget): Promise<string[]> {
    const spaceId = await this.resolveSpaceId(target.spaceKey);
    const pageIds: string[] = [];

    let url: string | undefined =
      `${this.apiBase}/spaces/${spaceId}/pages?status=current&limit=${PAGE_LIMIT}`;

    while (url) {
      const res: Response = await this.request(url);
      if (!res.ok) {
        throw new Error(
          `[confluence] failed to list pages for space ${target.spaceKey}: ${res.status} ${res.statusText}`
        );
      }

      const data: ConfluencePaginatedResponse<ConfluencePageSummary> = await res.json();
      for (const page of data.results) {
        pageIds.push(page.id);
        this.pageInfoCache.set(page.id, { title: page.title, parentId: page.parentId });
      }
      url = data._links?.next ? `${this.origin}${data._links.next}` : undefined;
    }

    return pageIds;
  }

  /** Walks the cached parentId chain to build a "Grandparent / Parent / Page" breadcrumb. */
  private pageBreadcrumb(pageId: string, ownTitle: string): string {
    const titles: string[] = [];
    let current = this.pageInfoCache.get(pageId)?.parentId ?? null;
    const seen = new Set<string>(); // guards against any (unexpected) cycle in the cached chain

    while (current && !seen.has(current)) {
      seen.add(current);
      const info: PageInfo | undefined = this.pageInfoCache.get(current);
      if (!info) break; // ancestor outside this space's listed pages (or above sync root) -- stop here
      titles.unshift(info.title);
      current = info.parentId;
    }

    titles.push(ownTitle);
    return titles.join(" / ");
  }

  /** Best-effort label fetch -- failures are logged and non-fatal, matching the plan's fail-soft stance. */
  private async fetchLabels(pageId: string): Promise<string[]> {
    try {
      const res = await this.request(`${this.apiBase}/pages/${pageId}/labels`);
      if (!res.ok) return [];
      const data: ConfluencePaginatedResponse<{ name: string }> = await res.json();
      return data.results.map((l) => l.name);
    } catch (err) {
      console.warn(`[confluence] failed to fetch labels for page ${pageId}:`, err);
      return [];
    }
  }

  /**
   * Fetches a single page's rendered ("view") HTML body, converts it to
   * Markdown, and normalizes it into a RawDocument. Fails soft (returns
   * null) on a non-OK response, matching BitbucketConnector's pattern.
   */
  async fetchFile(target: ConfluenceSyncTarget, pageId: string): Promise<RawDocument | null> {
    const res = await this.request(`${this.apiBase}/pages/${pageId}?body-format=view`);
    if (!res.ok) return null;

    const page: ConfluencePageDetail = await res.json();
    const html = page.body?.view?.value ?? "";
    const markdown = turndown.turndown(html);
    const pageTitle = this.pageBreadcrumb(pageId, page.title);
    const labels = await this.fetchLabels(pageId);

    return {
      sourceType: "confluence",
      sourceId: `confluence:${target.spaceKey}:${pageId}`,
      content: markdown,
      metadata: {
        repo: target.spaceKey,
        provider: "confluence",
        filePath: pageTitle,
        url: page._links?.webui ? `${this.baseUrl}${page._links.webui}` : undefined,
        lastModified: page.version?.createdAt,
        labels,
        contentHash: hashContent(markdown),
      },
    };
  }
}
