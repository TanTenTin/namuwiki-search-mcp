/**
 * Vercel 서버리스 진입점 (REST API).
 *
 * 기존 Express 앱(createApp)을 그대로 재사용한다.
 * Lightsail 배포(src/api/server.ts)와 동일한 검색 로직을 공유하며,
 * 차이는 환경변수(MEILISEARCH_HOST가 Caddy로 노출된 원격 주소)뿐이다.
 *
 * Vercel은 요청마다 함수를 호출하지만, 모듈 스코프 변수는 warm 인스턴스에서
 * 재사용되므로 검색 엔진을 1회만 초기화한다.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Express } from "express";
import { loadConfig, createSearchEngine } from "../src/config.js";
import { createApp } from "../src/api/server.js";

// warm 인스턴스 간 재사용되는 앱 캐시 (cold start 시 1회 초기화)
let appPromise: Promise<Express> | null = null;

/**
 * 검색 엔진을 초기화하고 Express 앱을 1회만 생성한다.
 */
function getApp(): Promise<Express> {
  if (!appPromise) {
    appPromise = (async (): Promise<Express> => {
      const config = loadConfig();
      const engine = await createSearchEngine(config);
      await engine.init();
      return createApp(engine);
    })();
  }
  return appPromise;
}

/**
 * Vercel Node.js 핸들러. Express 앱에 요청을 위임한다.
 */
export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const app = await getApp();
  app(req, res);
}
