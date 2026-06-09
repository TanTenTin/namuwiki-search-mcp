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
