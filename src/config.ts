/**
 * 환경 변수 로딩 및 검색 엔진 팩토리.
 *
 * .env를 읽어 설정 객체로 만들고, SEARCH_ENGINE 값에 따라
 * 적절한 SearchEngine 구현체를 생성한다.
 */

import "dotenv/config";
import type { SearchEngine } from "./search/engine.js";
import type { ApiKeyStore } from "./apikeys/store.js";
import type { UsageLogStore } from "./usagelog/store.js";

export interface AppConfig {
  searchEngine: "meilisearch" | "sqlite" | "mysql";
  meilisearch: {
    host: string;
    apiKey: string;
    index: string;
  };
  sqlite: {
    dbPath: string;
  };
  mysql: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
  };
  apiPort: number;
  mcp: {
    transport: "stdio" | "http";
    httpPort: number;
    /** MCP 서버가 검색 요청을 보낼 REST API의 베이스 URL */
    apiBaseUrl: string;
  };
  /** REST API 키 인증/발급 설정 */
  apiKeys: {
    /** 외부 요청에 API 키를 강제할지 (미지정 시 mysql 엔진이면 true) */
    required: boolean;
    /** 발급/폐기 엔드포인트(/admin/keys) 보호용 관리자 토큰 */
    adminToken: string;
    /** 키 검증 결과 인메모리 캐시 TTL(ms) */
    cacheTtlMs: number;
    /** 공개 셀프 발급(POST /keys) 설정 */
    selfIssue: {
      /** 셀프 발급 허용 여부 */
      enabled: boolean;
      /** 셀프 발급 키의 기본 분당 요청 한도 */
      ratePerMin: number;
      /** IP당 시간당 발급 가능 횟수(남용 방지) */
      maxPerHourPerIp: number;
    };
  };
  /** 크롤 폴백 설정 (인덱스에 없는 문서를 실시간 크롤로 보완) */
  crawl: {
    /** 폴백 활성화 여부(기본 false) */
    enabled: boolean;
    /** 요청 URL 템플릿. `{title}`가 URL 인코딩된 제목으로 치환된다. */
    urlTemplate: string;
    /** 요청 타임아웃(ms) */
    timeoutMs: number;
    /** 실패 시 재시도 횟수 */
    retries: number;
    /**
     * 크롤 결과를 영속 덤프 사이드카(JSONL)에도 append할지 여부(기본 false).
     * 데이터베이스제작자의 권리 리스크 때문에 기본은 인덱스 전용이며,
     * 명시적으로 켤 때만 파일에 누적한다.
     */
    appendDump: boolean;
    /** 덤프 사이드카 파일 경로 */
    dumpPath: string;
  };
  /** 응답 캐시 및 부하 보호 설정 */
  protection: {
    /** 응답 캐시 최대 항목 수 */
    cacheMaxEntries: number;
    /** 응답 캐시 TTL(ms) */
    cacheTtlMs: number;
    /** 동시 처리 요청 상한(초과 시 503) */
    maxConcurrent: number;
    /** 요청 처리 타임아웃(ms) */
    requestTimeoutMs: number;
  };
}

/**
 * 환경 변수에서 설정을 읽어온다.
 */
export function loadConfig(): AppConfig {
  const engine = (process.env.SEARCH_ENGINE ?? "sqlite").toLowerCase();
  const searchEngine: AppConfig["searchEngine"] =
    engine === "meilisearch" ? "meilisearch" : engine === "mysql" ? "mysql" : "sqlite";

  return {
    searchEngine,
    meilisearch: {
      host: process.env.MEILISEARCH_HOST ?? "http://localhost:7700",
      apiKey: process.env.MEILISEARCH_API_KEY ?? "masterKey",
      index: process.env.MEILISEARCH_INDEX ?? "namuwiki",
    },
    sqlite: {
      dbPath: process.env.SQLITE_DB_PATH ?? "./data/namuwiki.db",
    },
    mysql: {
      host: process.env.MYSQL_HOST ?? "localhost",
      port: Number(process.env.MYSQL_PORT ?? 3306),
      user: process.env.MYSQL_USER ?? "root",
      password: process.env.MYSQL_PASSWORD ?? "",
      database: process.env.MYSQL_DATABASE ?? "namuwiki",
    },
    apiPort: Number(process.env.API_PORT ?? 3000),
    mcp: {
      transport: (process.env.MCP_TRANSPORT ?? "stdio") === "http" ? "http" : "stdio",
      httpPort: Number(process.env.MCP_HTTP_PORT ?? 3001),
      apiBaseUrl: process.env.API_BASE_URL ?? `http://localhost:${Number(process.env.API_PORT ?? 3000)}`,
    },
    apiKeys: {
      // REQUIRE_API_KEY 미지정 시: 운영(mysql)은 키 필수, 로컬(sqlite 등)은 비활성.
      required:
        process.env.REQUIRE_API_KEY != null
          ? process.env.REQUIRE_API_KEY === "true"
          : searchEngine === "mysql",
      adminToken: process.env.ADMIN_API_TOKEN ?? "",
      cacheTtlMs: Number(process.env.API_KEY_CACHE_TTL_MS ?? 60_000),
      selfIssue: {
        enabled: (process.env.SELF_ISSUE ?? "true") === "true",
        ratePerMin: Number(process.env.SELF_ISSUE_RATE_PER_MIN ?? 30),
        maxPerHourPerIp: Number(process.env.SELF_ISSUE_MAX_PER_HOUR ?? 3),
      },
    },
    crawl: {
      enabled: (process.env.CRAWL_FALLBACK ?? "false") === "true",
      urlTemplate: process.env.NAMU_CRAWL_URL ?? "https://namu.wiki/w/{title}",
      timeoutMs: Number(process.env.CRAWL_TIMEOUT_MS ?? 5000),
      retries: Number(process.env.CRAWL_RETRIES ?? 2),
      appendDump: (process.env.CRAWL_APPEND_DUMP ?? "false") === "true",
      dumpPath: process.env.CRAWL_DUMP_PATH ?? "./data/crawled.jsonl",
    },
    protection: {
      cacheMaxEntries: Number(process.env.CACHE_MAX_ENTRIES ?? 5000),
      cacheTtlMs: Number(process.env.CACHE_TTL_MS ?? 300_000),
      maxConcurrent: Number(process.env.MAX_CONCURRENT ?? 20),
      requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS ?? 8000),
    },
  };
}

/**
 * 설정에 맞는 검색 엔진 인스턴스를 생성한다 (init은 호출하지 않음).
 *
 * 엔진 모듈을 동적 import한다 → 선택된 엔진의 의존성만 로드된다.
 * (Vercel에서 meilisearch만 쓸 때 better-sqlite3 네이티브 모듈이 로드되어
 *  빌드/런타임이 깨지는 문제를 방지한다.)
 */
export async function createSearchEngine(config: AppConfig): Promise<SearchEngine> {
  if (config.searchEngine === "meilisearch") {
    const { MeilisearchEngine } = await import("./search/meilisearch.js");
    return new MeilisearchEngine(
      config.meilisearch.host,
      config.meilisearch.apiKey,
      config.meilisearch.index,
    );
  }
  if (config.searchEngine === "mysql") {
    const { MysqlSearchEngine } = await import("./search/mysql.js");
    return new MysqlSearchEngine(config.mysql);
  }
  const { SqliteSearchEngine } = await import("./search/sqlite.js");
  return new SqliteSearchEngine(config.sqlite.dbPath);
}

/**
 * 크롤 폴백이 켜져 있으면 엔진을 CrawlFallbackEngine으로 감싼다.
 *
 * createSearchEngine과 분리한 이유: 인덱싱 스크립트(index-data.ts)는
 * `engine instanceof MeilisearchEngine` 같은 구체 타입 검사를 하므로,
 * 그 경로에서는 래핑하지 않고 REST 서버 기동 경로에서만 감싼다.
 */
export async function maybeWrapCrawlFallback(
  engine: SearchEngine,
  config: AppConfig,
): Promise<SearchEngine> {
  if (!config.crawl.enabled) return engine;

  const { CrawlFallbackEngine } = await import("./search/fallback.js");
  const appender = config.crawl.appendDump
    ? new (await import("./crawler/dump-append.js")).CrawledDumpAppender(config.crawl.dumpPath)
    : undefined;

  return new CrawlFallbackEngine(engine, {
    crawler: {
      urlTemplate: config.crawl.urlTemplate,
      timeoutMs: config.crawl.timeoutMs,
      retries: config.crawl.retries,
    },
    appender,
  });
}

/**
 * API 키 저장소를 생성한다 (init은 호출하지 않음).
 *
 * 검색 데이터(documents)는 SQLite(덤프, 재색인 가능)에 두지만,
 * API 키처럼 유실되면 안 되는 영속 데이터는 검색 엔진과 무관하게 항상 MySQL에 둔다.
 */
export async function createApiKeyStore(config: AppConfig): Promise<ApiKeyStore> {
  const { MysqlApiKeyStore } = await import("./apikeys/mysql.js");
  return new MysqlApiKeyStore(config.mysql, config.apiKeys.cacheTtlMs);
}

/**
 * 사용 로그 저장소를 생성한다 (init은 호출하지 않음).
 * 사용 로그도 영속 데이터이므로 MySQL에 둔다.
 */
export async function createUsageLogStore(config: AppConfig): Promise<UsageLogStore> {
  const { UsageLogStore } = await import("./usagelog/store.js");
  return new UsageLogStore(config.mysql);
}
