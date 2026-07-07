/**
 * 크롤 폴백 데코레이터.
 *
 * 기존 SearchEngine을 감싸, getArticle이 미발견(found:false)일 때
 * 나무위키를 실시간 크롤링해 결과를 반환하고 인덱스에 upsert한다.
 * 다른 메서드(init/index/search/health/close)는 내부 엔진에 그대로 위임한다.
 *
 * 프로젝트 규칙("새 엔진을 추가해도 API 레이어를 수정하지 않는다")에 맞춰
 * SearchEngine 인터페이스를 그대로 구현하므로, 라우트/MCP 코드는 변경이 없다.
 *
 * 법적 설계 결정(2026-07 기준):
 *   - 기본 동작은 "인덱스에만" 추가한다(파생/재생성 가능한 검색 캐시 성격).
 *   - 영속 덤프 사이드카 append는 데이터베이스제작자의 권리("상당한 부분" 복제)
 *     리스크를 키우므로 기본 비활성(opt-in)이다. appendDump가 있을 때만 기록한다.
 */

import type { SearchEngine } from "./engine.js";
import type {
  IndexedDocument,
  SearchResponse,
  ArticleResponse,
  SearchOptions,
} from "../types/index.js";
import { toIndexedDocument } from "../indexer/indexer.js";
import { fetchNamuArticle, type CrawlerOptions } from "../crawler/namu.js";
import type { CrawledDumpAppender } from "../crawler/dump-append.js";

export interface CrawlFallbackDeps {
  /** 크롤러 설정 */
  crawler: CrawlerOptions;
  /** 덤프 사이드카 기록기(opt-in). 없으면 인덱스에만 추가한다. */
  appender?: CrawledDumpAppender;
}

export class CrawlFallbackEngine implements SearchEngine {
  /**
   * 같은 제목에 대한 동시 크롤을 합치기 위한 in-flight 맵.
   * 동일 미발견 문서로 요청이 몰려도 크롤은 한 번만 수행한다.
   */
  private readonly inflight = new Map<string, Promise<ArticleResponse>>();

  constructor(
    private readonly inner: SearchEngine,
    private readonly deps: CrawlFallbackDeps,
  ) {}

  async init(): Promise<void> {
    await this.inner.init();
  }

  async index(docs: IndexedDocument[]): Promise<void> {
    await this.inner.index(docs);
  }

  async search(query: string, options?: SearchOptions): Promise<SearchResponse> {
    return this.inner.search(query, options);
  }

  async health(): Promise<boolean> {
    return this.inner.health();
  }

  async close(): Promise<void> {
    await this.inner.close?.();
  }

  async getArticle(title: string, plainText = true): Promise<ArticleResponse> {
    // 1) 먼저 덤프/인덱스에서 조회. 있으면 출처를 dump로 표기해 반환.
    const local = await this.inner.getArticle(title, plainText);
    if (local.found) return { ...local, source: "dump" };

    // 2) 미발견 → 크롤 폴백. 동일 제목 동시 요청은 하나로 합친다.
    const existing = this.inflight.get(title);
    if (existing) return existing;

    const task = this.crawlAndIndex(title, plainText, local);
    this.inflight.set(title, task);
    try {
      return await task;
    } finally {
      this.inflight.delete(title);
    }
  }

  /**
   * 크롤 → 인덱스 upsert → (opt-in) 덤프 append → 응답 구성.
   * 크롤 실패/미발견 시에는 내부 엔진의 원래 found:false 응답을 그대로 돌려준다.
   */
  private async crawlAndIndex(
    title: string,
    plainText: boolean,
    fallback: ArticleResponse,
  ): Promise<ArticleResponse> {
    const doc = await fetchNamuArticle(title, this.deps.crawler);
    if (!doc) return fallback; // 미발견/차단/실패 → 기존 found:false 유지

    const indexed = toIndexedDocument(doc);

    // 인덱스 반영은 즉시 검색/재조회에 필요하므로 await한다.
    // 실패해도 폴백 응답 자체는 반환한다(best-effort).
    try {
      await this.inner.index([indexed]);
    } catch (err) {
      console.error(
        "[crawler] 인덱스 upsert 실패:",
        err instanceof Error ? err.message : String(err),
      );
    }

    // 덤프 사이드카 기록은 opt-in일 때만. 응답을 지연시키지 않도록 대기하지 않는다.
    if (this.deps.appender) {
      void this.deps.appender.append(doc);
    }

    return {
      title: doc.title,
      text: plainText ? indexed.text : indexed.text_raw,
      contributors: doc.contributors,
      found: true,
      source: "crawled",
    };
  }
}
