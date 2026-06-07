/**
 * 검색 관련 REST 라우트.
 *
 * 이 라우트들이 검색 기능의 "유일한" 구현 지점이다.
 * MCP 서버는 이 엔드포인트를 HTTP로 호출하여 동일 기능을 재사용한다.
 *
 *   GET /search?q=<키워드>&limit=<수>&namespace=<네임스페이스>
 *   GET /article/:title?plain_text=<true|false>
 */

import { Router, type Request, type Response } from "express";
import type { SearchEngine } from "../../search/engine.js";

/**
 * 검색 라우터를 생성한다.
 * @param engine 초기화된 검색 엔진 (의존성 주입)
 */
export function createSearchRouter(engine: SearchEngine): Router {
  const router = Router();

  // GET /search?q=...&limit=...&namespace=...
  router.get("/search", async (req: Request, res: Response) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!q) {
      return res.status(400).json({ error: "검색어(q) 파라미터가 필요합니다." });
    }

    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const namespace =
      typeof req.query.namespace === "string" ? req.query.namespace : undefined;

    try {
      const result = await engine.search(q, { limit, namespace });
      res.json(result);
    } catch (err) {
      // 검색 엔진 연결 실패 등은 503으로 명확히 알린다.
      res.status(503).json({
        error: "검색 엔진을 사용할 수 없습니다.",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // GET /article/:title?plain_text=true
  router.get("/article/:title", async (req: Request, res: Response) => {
    const title = decodeURIComponent(String(req.params.title));
    // plain_text 기본값 true. "false"일 때만 원문 반환.
    const plainText = req.query.plain_text !== "false";

    try {
      const result = await engine.getArticle(title, plainText);
      // 미발견도 200 + found:false (프로젝트 규칙)
      res.json(result);
    } catch (err) {
      res.status(503).json({
        error: "검색 엔진을 사용할 수 없습니다.",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return router;
}
