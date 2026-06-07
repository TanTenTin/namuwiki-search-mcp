/**
 * Express REST API 서버 진입점.
 *
 * 검색 엔진을 초기화하고 라우트를 마운트한 뒤 서버를 띄운다.
 * 검색 비즈니스 로직의 단일 소스 역할을 한다.
 */

import express from "express";
import { pathToFileURL } from "node:url";
import { loadConfig, createSearchEngine } from "../config.js";
import { createSearchRouter } from "./routes/search.js";
import type { SearchEngine } from "../search/engine.js";

/**
 * Express 앱을 구성한다 (테스트에서 서버 기동 없이 재사용 가능).
 * @param engine 초기화된 검색 엔진
 */
export function createApp(engine: SearchEngine) {
  const app = express();
  app.use(express.json());

  // 헬스체크
  app.get("/health", async (_req, res) => {
    const ok = await engine.health();
    res.status(ok ? 200 : 503).json({ status: ok ? "ok" : "unavailable" });
  });

  // 검색/문서 라우트
  app.use("/", createSearchRouter(engine));

  return app;
}

/**
 * 서버를 기동한다.
 */
export async function startServer(): Promise<void> {
  const config = loadConfig();
  const engine = await createSearchEngine(config);
  await engine.init();

  const app = createApp(engine);

  app.listen(config.apiPort, () => {
    console.error(
      `[api] REST API 서버 실행 중: http://localhost:${config.apiPort} ` +
        `(엔진: ${config.searchEngine})`,
    );
  });
}

// 이 파일이 직접 실행될 때만 서버를 띄운다 (import 시에는 실행 안 함).
const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  startServer().catch((err) => {
    console.error("[api] 서버 기동 실패:", err);
    process.exit(1);
  });
}
