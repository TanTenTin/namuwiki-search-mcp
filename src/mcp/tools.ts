/**
 * MCP 툴 정의.
 *
 * 핵심 설계: 검색 로직을 직접 구현하지 않는다.
 * 모든 툴은 REST API(GET /search, GET /article/:title)를 HTTP로 호출하여
 * 동일 기능을 재사용한다. (로직 중복 제거)
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { SearchResponse, ArticleResponse } from "../types/index.js";

// ── 입력 스키마 (Zod) ────────────────────────────

export const searchInputSchema = z.object({
  query: z.string().describe("검색 키워드"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe("결과 수 (기본값: 5, 최대: 20)"),
  namespace: z
    .string()
    .optional()
    .describe("네임스페이스 필터 (기본값: 일반 문서만)"),
});

export const getArticleInputSchema = z.object({
  title: z.string().describe("정확한 문서 제목"),
  plain_text: z
    .boolean()
    .optional()
    .describe("true면 마크업 제거 후 반환 (기본값: true)"),
});

/**
 * MCP 툴 메타데이터 (이름/설명/JSON Schema).
 * MCP SDK의 ListTools 응답에 사용한다.
 */
export const TOOL_DEFINITIONS = [
  {
    name: "search_namuwiki",
    description: "나무위키에서 키워드로 문서를 검색한다.",
    inputSchema: zodToJsonSchema(searchInputSchema, { target: "jsonSchema7" }),
  },
  {
    name: "get_namuwiki_article",
    description: "나무위키 문서를 제목으로 가져온다.",
    inputSchema: zodToJsonSchema(getArticleInputSchema, { target: "jsonSchema7" }),
  },
] as const;

// ── REST API 클라이언트 ───────────────────────────

/**
 * REST API를 호출하는 얇은 클라이언트.
 * MCP 툴 구현은 모두 이 클라이언트를 통해 동작한다.
 */
export class NamuApiClient {
  private readonly headers: Record<string, string>;

  /**
   * @param baseUrl REST API 베이스 URL
   * @param token   상위(MCP 클라이언트)에서 전달받은 API 키. namu-api 인증에 그대로 첨부한다.
   */
  constructor(
    private readonly baseUrl: string,
    token?: string,
  ) {
    this.headers = token ? { Authorization: `Bearer ${token}` } : {};
  }

  /** GET /search */
  async search(input: z.infer<typeof searchInputSchema>): Promise<SearchResponse> {
    const url = new URL("/search", this.baseUrl);
    url.searchParams.set("q", input.query);
    if (input.limit != null) url.searchParams.set("limit", String(input.limit));
    if (input.namespace) url.searchParams.set("namespace", input.namespace);

    const res = await fetch(url, { headers: this.headers });
    if (!res.ok) {
      throw new Error(`검색 API 오류 (${res.status}): ${await res.text()}`);
    }
    return (await res.json()) as SearchResponse;
  }

  /** GET /article/:title */
  async getArticle(
    input: z.infer<typeof getArticleInputSchema>,
  ): Promise<ArticleResponse> {
    const url = new URL(
      `/article/${encodeURIComponent(input.title)}`,
      this.baseUrl,
    );
    if (input.plain_text === false) url.searchParams.set("plain_text", "false");

    const res = await fetch(url, { headers: this.headers });
    if (!res.ok) {
      throw new Error(`문서 API 오류 (${res.status}): ${await res.text()}`);
    }
    return (await res.json()) as ArticleResponse;
  }
}
