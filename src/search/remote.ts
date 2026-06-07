/**
 * 원격 REST API로 위임하는 검색 엔진 (읽기 전용).
 *
 * 자체적으로 DB/검색엔진에 연결하지 않고, 이미 구동 중인 다른 REST API
 * (GET /search, GET /article/:title, GET /health)로 요청을 포워딩한다.
 *
 * 용도: Vercel REST API가 DB(RDS)에 직접 붙지 않고 Lightsail의 내부 api를
 *       경유하도록 한다. 이렇게 하면 DB 자격증명이 Vercel에 없어도 되고,
 *       RDS 보안 그룹은 Lightsail 고정 IP만 허용하면 된다.
 */

import type { SearchEngine } from "./engine.js";
import type {
  IndexedDocument,
  SearchResponse,
  ArticleResponse,
  SearchOptions,
} from "../types/index.js";

export class RemoteSearchEngine implements SearchEngine {
  private readonly base: string;
  private readonly headers: Record<string, string>;

  /**
   * @param baseUrl 업스트림 REST API 베이스 URL (경로 prefix 포함 가능)
   * @param token 업스트림 보호용 Bearer 토큰 (Caddy 등 앞단에서 검증)
   */
  constructor(baseUrl: string, token?: string) {
    // 베이스 URL 끝 슬래시를 제거해 경로 prefix를 보존한 채 이어붙인다.
    // (new URL("/search", base)는 leading slash 때문에 prefix를 날리므로 쓰지 않는다.)
    this.base = baseUrl.replace(/\/+$/, "");
    this.headers = token ? { Authorization: `Bearer ${token}` } : {};
  }

  async init(): Promise<void> {
    // 원격 엔진은 별도 초기화가 필요 없다 (업스트림이 이미 구동 중).
  }

  async index(_docs: IndexedDocument[]): Promise<void> {
    // 읽기 전용. 인덱싱은 업스트림(또는 인덱싱 스크립트)에서 직접 수행한다.
    throw new Error("RemoteSearchEngine은 읽기 전용입니다. 인덱싱은 업스트림에서 수행하세요.");
  }

  async search(query: string, options?: SearchOptions): Promise<SearchResponse> {
    const url = new URL(`${this.base}/search`);
    url.searchParams.set("q", query);
    if (options?.limit != null) url.searchParams.set("limit", String(options.limit));
    if (options?.namespace) url.searchParams.set("namespace", options.namespace);

    const res = await fetch(url, { headers: this.headers });
    if (!res.ok) {
      throw new Error(`업스트림 검색 오류 (${res.status}): ${await res.text()}`);
    }
    return (await res.json()) as SearchResponse;
  }

  async getArticle(title: string, plainText = true): Promise<ArticleResponse> {
    const url = new URL(`${this.base}/article/${encodeURIComponent(title)}`);
    if (!plainText) url.searchParams.set("plain_text", "false");

    const res = await fetch(url, { headers: this.headers });
    if (!res.ok) {
      throw new Error(`업스트림 문서 오류 (${res.status}): ${await res.text()}`);
    }
    return (await res.json()) as ArticleResponse;
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(new URL(`${this.base}/health`), { headers: this.headers });
      if (!res.ok) return false;
      const body = (await res.json()) as { status?: string };
      return body.status === "ok";
    } catch {
      return false;
    }
  }
}
