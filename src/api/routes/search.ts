/**
 * 검색 관련 REST 라우트.
 *
 * 이 라우트들이 검색 기능의 "유일한" 구현 지점이다.
 * MCP 서버는 이 엔드포인트를 HTTP로 호출하여 동일 기능을 재사용한다.
 *
 *   GET /search?q=<키워드>&limit=<수>&namespace=<네임스페이스>
 *   GET /article/:title?plain_text=<true|false>
 *
 * 선택적 응답 캐시(RouteCache)를 받으면 성공 응답을 캐시해 검색엔진/DB 부하를 줄인다.
 */

import { Router, type Request, type Response } from "express";
import type { SearchEngine } from "../../search/engine.js";
import type { RouteCache } from "../cache.js";

/** 캐시 키 구분자. 검색어/네임스페이스에 등장하지 않는 제어문자(US, 0x1F). */
const SEP = String.fromCharCode(31);

/**
 * 검색 라우터를 생성한다.
 * @param engine 초기화된 검색 엔진 (의존성 주입)
 * @param cache  선택적 응답 캐시 (생략 시 캐싱하지 않음)
 */
export function createSearchRouter(engine: SearchEngine, cache?: RouteCache): Router {
  const router = Router();

  // GET /search?q=...&limit=...&namespace=...
  router.get("/search", async (req: Request, res: Response): Promise<void> => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!q) {
      res.status(400).json({ error: "검색어(q) 파라미터가 필요합니다." });
      return;
    }

    // limit 정규화: 유한한 양수만 허용(상한은 엔진이 보정). 비정상 입력(NaN 등)은 undefined.
    const rawLimit = Number(req.query.limit);
    const limit =
      req.query.limit != null && Number.isFinite(rawLimit) && rawLimit > 0
        ? rawLimit
        : undefined;
    const namespace =
      typeof req.query.namespace === "string" ? req.query.namespace : undefined;

    const cacheKey = `${q}${SEP}${limit ?? ""}${SEP}${namespace ?? ""}`;
    const hit = cache?.search.get(cacheKey);
    if (hit) {
      if (!res.headersSent) res.json(hit);
      return;
    }

    try {
      const result = await engine.search(q, { limit, namespace });
      cache?.search.set(cacheKey, result);
      // 타임아웃 미들웨어가 이미 응답했을 수 있으므로 늦은 쓰기를 건너뛴다.
      if (!res.headersSent) res.json(result);
    } catch (err) {
      // 검색 엔진 연결 실패 등은 503으로 명확히 알린다.
      if (!res.headersSent) {
        res.status(503).json({
          error: "검색 엔진을 사용할 수 없습니다.",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });

  // GET /article/:title?plain_text=true
  router.get("/article/:title", async (req: Request, res: Response): Promise<void> => {
    const title = decodeURIComponent(String(req.params.title));
    // plain_text 기본값 true. "false"일 때만 원문 반환.
    const plainText = req.query.plain_text !== "false";

    const cacheKey = `${title}${SEP}${plainText}`;
    const hit = cache?.article.get(cacheKey);
    if (hit) {
      if (!res.headersSent) res.json(hit);
      return;
    }

    try {
      const result = await engine.getArticle(title, plainText);
      // 미발견(found:false)도 안정적이므로 캐시한다.
      cache?.article.set(cacheKey, result);
      if (!res.headersSent) res.json(result);
    } catch (err) {
      if (!res.headersSent) {
        res.status(503).json({
          error: "검색 엔진을 사용할 수 없습니다.",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });

  return router;
}
