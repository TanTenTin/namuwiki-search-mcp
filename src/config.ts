/**
 * 환경 변수 로딩 및 검색 엔진 팩토리.
 *
 * .env를 읽어 설정 객체로 만들고, SEARCH_ENGINE 값에 따라
 * 적절한 SearchEngine 구현체를 생성한다.
 */

import "dotenv/config";
import type { SearchEngine } from "./search/engine.js";

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
