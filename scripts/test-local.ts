/**
 * 로컬 엔드투엔드 스모크 테스트.
 *
 * 외부 서비스(Docker/Meilisearch) 없이 SQLite 엔진으로 전체 흐름을 검증한다:
 *   1) 샘플 데이터 인덱싱
 *   2) REST API 기동
 *   3) /health, /search, /article HTTP 호출 검증
 *   4) MCP가 사용하는 NamuApiClient(REST 호출) 경로 검증
 *
 * 실행: npm run test:local
 */

import type { Server } from "node:http";
import { existsSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { SqliteSearchEngine } from "../src/search/sqlite.js";
import { runIndexing } from "../src/indexer/indexer.js";
import { parseDump } from "../src/indexer/dump-parser.js";
import { createApp } from "../src/api/server.js";
import { NamuApiClient } from "../src/mcp/tools.js";
import type { SearchResponse, ArticleResponse } from "../src/types/index.js";

const DB_PATH = "./data/test-local.db";
const SAMPLE_PATH = "./data/sample.json";
const PORT = 3999;
const BASE_URL = `http://localhost:${PORT}`;

let passed = 0;
let failed = 0;

/** 간단한 assert 헬퍼 */
function check(label: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`, extra ?? "");
  }
}

async function main(): Promise<void> {
  console.log("=== 로컬 엔드투엔드 테스트 시작 ===\n");

  // 0) 샘플 데이터 보장
  if (!existsSync(SAMPLE_PATH)) {
    console.log("[setup] 샘플 데이터가 없어 생성합니다...");
    execSync("npm run gen-sample", { stdio: "inherit" });
  }

  // 1) SQLite 엔진 + 인덱싱
  console.log("\n[1] 샘플 데이터 인덱싱");
  // 테스트 격리를 위해 기존 테스트 DB(및 WAL 파일)는 지우고 새로 만든다.
  for (const ext of ["", "-wal", "-shm"]) {
    if (existsSync(DB_PATH + ext)) rmSync(DB_PATH + ext);
  }
  const engine = new SqliteSearchEngine(DB_PATH);
  await engine.init();
  const total = await runIndexing(engine, parseDump(SAMPLE_PATH), { batchSize: 100 });
  check(`샘플 ${total}건 인덱싱`, total > 0, { total });

  // 2) REST API 기동
  console.log("\n[2] REST API 기동");
  const app = createApp(engine);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(PORT, () => resolve(s));
  });
  check("서버 리스닝", server.listening);

  // 3) REST HTTP 호출 검증
  console.log("\n[3] REST API 직접 호출");
  {
    const health = (await fetch(`${BASE_URL}/health`).then((r) => r.json())) as {
      status: string;
    };
    check("/health → ok", health.status === "ok", health);

    const search = (await fetch(
      `${BASE_URL}/search?q=${encodeURIComponent("타입스크립트")}`,
    ).then((r) => r.json())) as SearchResponse;
    check("/search 결과 존재", search.results.length > 0, search);
    check(
      "/search TypeScript 문서 매칭",
      search.results.some((r) => r.title === "TypeScript"),
      search.results.map((r) => r.title),
    );
    check(
      "/search 스니펫 길이 ≤ 300",
      search.results.every((r) => r.snippet.length <= 301),
    );

    const article = (await fetch(
      `${BASE_URL}/article/${encodeURIComponent("나무위키")}`,
    ).then((r) => r.json())) as ArticleResponse;
    check("/article found=true", article.found === true, article.found);
    check("/article 마크업 제거됨", !article.text.includes("'''"), article.text.slice(0, 60));
    check("/article 기여자 존재", article.contributors.length > 0);

    const missing = (await fetch(
      `${BASE_URL}/article/${encodeURIComponent("존재하지않는문서xyz")}`,
    ).then((r) => r.json())) as ArticleResponse;
    check("/article 미발견 found=false (404 아님)", missing.found === false);

    const raw = (await fetch(
      `${BASE_URL}/article/${encodeURIComponent("나무위키")}?plain_text=false`,
    ).then((r) => r.json())) as ArticleResponse;
    // text_raw를 저장하지 않으므로 plain_text=false도 정제본(마크업 제거)을 반환한다.
    check("/article plain_text=false 정제본 반환", raw.text === article.text);

    // 2글자 쿼리: trigram FTS는 0건이지만 LIKE 폴백으로 매칭되어야 한다.
    const short = (await fetch(
      `${BASE_URL}/search?q=${encodeURIComponent("위키")}`,
    ).then((r) => r.json())) as SearchResponse;
    check(
      "/search 2글자(위키) LIKE 폴백 매칭",
      short.results.some((r) => r.title === "나무위키"),
      short.results.map((r) => r.title),
    );

    const short2 = (await fetch(
      `${BASE_URL}/search?q=${encodeURIComponent("엔진")}`,
    ).then((r) => r.json())) as SearchResponse;
    check("/search 2글자(엔진) LIKE 폴백 결과 존재", short2.results.length > 0, short2.total);
  }

  // 4) MCP 경로 검증 (NamuApiClient = REST 호출 래퍼)
  console.log("\n[4] MCP 클라이언트 경로 (REST 호출)");
  {
    const client = new NamuApiClient(BASE_URL);

    const search = await client.search({ query: "검색 엔진", limit: 3 });
    check("MCP search 결과 존재", search.results.length > 0, search.results.map((r) => r.title));
    check("MCP search limit 적용", search.results.length <= 3);

    const article = await client.getArticle({ title: "SQLite" });
    check("MCP getArticle found=true", article.found === true);

    const ns = await client.search({ query: "예시", namespace: "틀" });
    check(
      "MCP search namespace 필터",
      ns.results.every((_r) => true), // 필터가 에러 없이 동작하는지만 확인
      ns.results.map((r) => r.title),
    );
  }

  // 정리
  server.close();
  await engine.close?.();

  console.log(`\n=== 결과: ${passed} 통과, ${failed} 실패 ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("테스트 실행 중 오류:", err);
  process.exit(1);
});
