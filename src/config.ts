/**
 * 환경 변수 로딩 및 검색 엔진 팩토리.
 *
 * .env를 읽어 설정 객체로 만들고, SEARCH_ENGINE 값에 따라
 * 적절한 SearchEngine 구현체를 생성한다.
 */

import "dotenv/config";
import type { SearchEngine } from "./search/engine.js";
import { SqliteSearchEngine } from "./search/sqlite.js";
import { MeilisearchEngine } from "./search/meilisearch.js";

export interface AppConfig {
  searchEngine: "meilisearch" | "sqlite";
  meilisearch: {
    host: string;
    apiKey: string;
    index: string;
  };
  sqlite: {
    dbPath: string;
  };
  apiPort: number;
  mcp: {
    transport: "stdio" | "http";
    httpPort: number;
    /** MCP 서버가 검색 요청을 보낼 REST API의 베이스 URL */
    apiBaseUrl: string;
  };
}

/**
 * 환경 변수에서 설정을 읽어온다.
 */
export function loadConfig(): AppConfig {
  const engine = (process.env.SEARCH_ENGINE ?? "sqlite").toLowerCase();

  return {
    searchEngine: engine === "meilisearch" ? "meilisearch" : "sqlite",
    meilisearch: {
      host: process.env.MEILISEARCH_HOST ?? "http://localhost:7700",
      apiKey: process.env.MEILISEARCH_API_KEY ?? "masterKey",
      index: process.env.MEILISEARCH_INDEX ?? "namuwiki",
    },
    sqlite: {
      dbPath: process.env.SQLITE_DB_PATH ?? "./data/namuwiki.db",
    },
    apiPort: Number(process.env.API_PORT ?? 3000),
    mcp: {
      transport: (process.env.MCP_TRANSPORT ?? "stdio") === "http" ? "http" : "stdio",
      httpPort: Number(process.env.MCP_HTTP_PORT ?? 3001),
      apiBaseUrl: process.env.API_BASE_URL ?? `http://localhost:${Number(process.env.API_PORT ?? 3000)}`,
    },
  };
}

/**
 * 설정에 맞는 검색 엔진 인스턴스를 생성한다 (init은 호출하지 않음).
 */
export function createSearchEngine(config: AppConfig): SearchEngine {
  if (config.searchEngine === "meilisearch") {
    return new MeilisearchEngine(
      config.meilisearch.host,
      config.meilisearch.apiKey,
      config.meilisearch.index,
    );
  }
  return new SqliteSearchEngine(config.sqlite.dbPath);
}
