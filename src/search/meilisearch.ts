/**
 * Meilisearch 기반 검색 엔진 구현체 (기본 프로덕션 엔진).
 *
 * 한국어 검색 품질이 SQLite FTS5보다 우수하며, 대용량 인덱싱/필터링에 적합하다.
 * 로컬에서 쓰려면 docker-compose로 Meilisearch 컨테이너를 먼저 띄워야 한다.
 */

import { MeiliSearch, type Index } from "meilisearch";
import type { SearchEngine } from "./engine.js";
import { normalizeLimit } from "./engine.js";
import type {
  IndexedDocument,
  SearchResponse,
  ArticleResponse,
  SearchOptions,
} from "../types/index.js";
import { makeSnippet } from "../indexer/markup.js";
import { rerankHits, poolSizeFor } from "./rerank.js";
import { canonicalOf } from "./synonyms.js";

export class MeilisearchEngine implements SearchEngine {
  private client: MeiliSearch;
  // 인터페이스의 index() 메서드와 이름이 겹치지 않도록 필드는 idx로 둔다.
  private idx: Index | null = null;

  constructor(
    host: string,
    apiKey: string,
    private readonly indexName: string,
  ) {
    this.client = new MeiliSearch({ host, apiKey });
  }

  async init(): Promise<void> {
    // 인덱스 참조는 항상 확보한다. client.index()는 로컬 연산이라
    // 네트워크 호출/권한이 필요 없으므로 어떤 키로도 안전하다.
    this.idx = this.client.index(this.indexName);

    // 인덱스 생성/설정은 쓰기 권한이 필요하다.
    // 검색 전용(search-only) 키로 동작하는 읽기 경로(예: Vercel REST API)에서는
    // 권한이 없어 실패하므로, 실패해도 검색은 계속 가능하도록 경고만 남기고 넘어간다.
    // 실제 프로비저닝은 마스터 키를 쓰는 인덱싱 단계에서 수행된다.
    try {
      // 인덱스가 없으면 생성한다 (primaryKey = id).
      try {
        await this.client.getIndex(this.indexName);
      } catch {
        const task = await this.client.createIndex(this.indexName, { primaryKey: "id" });
        await this.client.waitForTask(task.taskUid);
      }

      // 검색/필터 가능한 속성을 설정한다.
      await this.idx.updateSettings({
        searchableAttributes: ["title", "text"],
        filterableAttributes: ["namespace"],
        // 스니펫은 자체 makeSnippet으로 생성하므로 displayed는 전체 유지
        displayedAttributes: ["id", "namespace", "title", "text", "text_raw", "contributors"],
      });
    } catch (err) {
      console.error(
        "[meilisearch] 인덱스 프로비저닝 건너뜀 (검색 전용 키이거나 권한 부족). " +
          "검색은 계속 동작하며, 인덱스 생성/설정은 인덱싱 단계에서 수행됨: " +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  private ensureIndex(): Index {
    if (!this.idx) throw new Error("MeilisearchEngine가 초기화되지 않았습니다. init()을 먼저 호출하세요.");
    return this.idx;
  }

  async index(docs: IndexedDocument[]): Promise<void> {
    // addDocuments는 비동기 태스크를 큐잉한다. 인덱싱 스크립트에서
    // 대량 호출 시 매번 기다리면 느려지므로 여기서는 큐잉만 하고
    // 완료 대기는 호출 측(indexer)에서 일괄 처리하도록 한다.
    await this.ensureIndex().addDocuments(docs);
  }

  async search(query: string, options?: SearchOptions): Promise<SearchResponse> {
    const index = this.ensureIndex();
    const limit = normalizeLimit(options?.limit);
    // 재정렬로 대표 문서를 끌어올리려면 후보를 넉넉히 조회해 풀에 담아야 한다.
    const poolSize = poolSizeFor(limit);

    // 검색어가 알려진 별칭이면 정식 제목 용어로 보조 검색을 하나 더 돌려
    // 정식 문서를 후보에 합친다. (title 필터가 없어 직접 주입이 어렵기 때문.
    // 예: "BTS" → "방탄소년단". 요구사항 [2] 큐레이션 동의어)
    const canonical = canonicalOf(query);
    const filter = options?.namespace ? [`namespace = "${options.namespace}"`] : undefined;

    const [result, canonResult] = await Promise.all([
      index.search(query, {
        limit: poolSize,
        filter,
        attributesToRetrieve: ["title", "text"],
        showRankingScore: true,
      }),
      canonical
        ? index.search(canonical, {
            limit: 10,
            filter,
            attributesToRetrieve: ["title", "text"],
            showRankingScore: true,
          })
        : Promise.resolve(null),
    ]);

    // 후보를 중간 형태로 정규화하고, 별칭 보조 검색 결과를 제목 기준으로 합친다.
    // (title 완전일치 부스팅[1][2] + 하위 문서 페널티[4])
    const toCandidate = (hit: Record<string, unknown>): { title: string; text: string; score: number } => ({
      title: hit.title as string,
      text: (hit.text as string) ?? "",
      // Meilisearch의 _rankingScore는 0~1. 높을수록 관련도 높음.
      score: (hit as { _rankingScore?: number })._rankingScore ?? 0,
    });

    const candidates = result.hits.map(toCandidate);
    if (canonResult) {
      const seen = new Set(candidates.map((c) => c.title));
      for (const hit of canonResult.hits) {
        const c = toCandidate(hit as Record<string, unknown>);
        if (!seen.has(c.title)) candidates.push(c);
      }
    }

    const ranked = rerankHits(candidates, query, limit, canonical);
    const results = ranked.map((c) => ({
      title: c.title,
      snippet: makeSnippet(c.text, query, 300),
      score: c.score,
    }));

    return {
      results,
      total: result.estimatedTotalHits ?? results.length,
    };
  }

  async getArticle(title: string, plainText = true): Promise<ArticleResponse> {
    const index = this.ensureIndex();

    // 제목 완전 일치 검색. filter로 정확 매칭을 시도하되,
    // title은 filterable이 아니므로 검색 후 제목 동일 항목을 고른다.
    const result = await index.search(title, {
      limit: 5,
      attributesToRetrieve: ["title", "text", "text_raw", "contributors"],
    });

    const hit = result.hits.find((h) => (h.title as string) === title);
    if (!hit) {
      return { title, text: "", contributors: [], found: false };
    }

    return {
      title: hit.title as string,
      text: plainText ? (hit.text as string) : (hit.text_raw as string),
      contributors: (hit.contributors as string[]) ?? [],
      found: true,
    };
  }

  async health(): Promise<boolean> {
    try {
      const health = await this.client.health();
      return health.status === "available";
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    // Meilisearch 클라이언트는 별도 연결 해제가 필요 없다 (HTTP 기반).
    this.idx = null;
  }

  /**
   * 큐잉된 인덱싱 태스크가 모두 끝날 때까지 대기한다.
   * 인덱싱 스크립트 종료 직전에 호출한다.
   */
  async waitForIndexing(): Promise<void> {
    const tasks = await this.client.getTasks({ statuses: ["enqueued", "processing"] });
    for (const task of tasks.results) {
      await this.client.waitForTask(task.uid);
    }
  }
}
