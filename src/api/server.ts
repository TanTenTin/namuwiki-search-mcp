/**
 * Express REST API 서버 진입점.
 *
 * 검색 비즈니스 로직의 단일 소스. MCP 서버는 이 API를 HTTP로 호출한다.
 * 부하 보호: 응답 캐시 + 동시성 상한 + 요청 타임아웃 + (운영) API 키 인증·키별 rate-limit.
 */

import express, {
  Router,
  type Request,
  type Response,
  type NextFunction,
  type RequestHandler,
} from "express";
import { rateLimit, type RateLimitRequestHandler } from "express-rate-limit";
import { pathToFileURL } from "node:url";
import {
  loadConfig,
  createSearchEngine,
  maybeWrapCrawlFallback,
  createApiKeyStore,
  createUsageLogStore,
  type AppConfig,
} from "../config.js";
import { createSearchRouter } from "./routes/search.js";
import { createRouteCache } from "./cache.js";
import type { SearchEngine } from "../search/engine.js";
import type { ApiKeyStore, ApiKeyRecord } from "../apikeys/store.js";
import type { UsageLogStore } from "../usagelog/store.js";

export interface CreateAppOptions {
  /** 전체 설정 (부하 보호·키 인증 동작 결정). 생략 시 보호 미들웨어 없이 동작(테스트용). */
  config?: AppConfig;
  /** API 키 저장소. config.apiKeys.required일 때 필요. */
  apiKeyStore?: ApiKeyStore | null;
  /** 사용 로그 저장소 (선택). 있으면 검색/문서 호출을 비동기로 기록한다. */
  usageLog?: UsageLogStore | null;
}

/** 요청 헤더에서 Bearer 토큰 또는 X-API-Key 값을 추출한다. */
function extractToken(req: Request): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length).trim() || null;
  }
  const apiKeyHeader = req.headers["x-api-key"];
  if (typeof apiKeyHeader === "string" && apiKeyHeader.trim()) {
    return apiKeyHeader.trim();
  }
  return null;
}

/** res.locals에 실린 검증된 API 키 레코드를 꺼낸다. */
function getApiKey(res: Response): ApiKeyRecord | undefined {
  return (res.locals as { apiKey?: ApiKeyRecord }).apiKey;
}

/**
 * 동시 처리 요청 수를 제한한다. 상한 초과 시 즉시 503으로 떨궈
 * 소형 서버가 한꺼번에 몰리는 요청에 무너지지 않게 한다.
 */
function createConcurrencyLimiter(max: number): RequestHandler {
  let active = 0;
  return function concurrencyLimiter(_req: Request, res: Response, next: NextFunction): void {
    if (active >= max) {
      res.setHeader("Retry-After", "1");
      res.status(503).json({ error: "서버가 혼잡합니다. 잠시 후 다시 시도해주세요." });
      return;
    }
    active++;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      active--;
    };
    res.on("finish", release);
    res.on("close", release);
    next();
  };
}

/**
 * 요청 처리 타임아웃. 초과 시 503을 보낸다(이미 응답이 시작됐으면 무시).
 * 라우트 핸들러는 res.headersSent를 확인하고 늦은 쓰기를 건너뛴다.
 */
function createTimeout(ms: number): RequestHandler {
  return function requestTimeout(_req: Request, res: Response, next: NextFunction): void {
    const timer = setTimeout(() => {
      if (!res.headersSent) {
        res.status(503).json({ error: "요청 처리 시간이 초과되었습니다." });
      }
    }, ms);
    const clear = (): void => clearTimeout(timer);
    res.on("finish", clear);
    res.on("close", clear);
    next();
  };
}

/**
 * API 키 인증 미들웨어. 토큰을 검증해 res.locals.apiKey에 싣는다.
 * 운영(키 필수) 모드에서만 마운트된다. 내부 MCP→api 호출도 사용자 키를
 * 그대로 들고 오므로 동일하게 검증된다.
 */
function createApiKeyAuth(store: ApiKeyStore): RequestHandler {
  return async function apiKeyAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    const token = extractToken(req);
    if (!token) {
      res.status(401).json({ error: "API 키가 필요합니다 (Authorization: Bearer <키>)." });
      return;
    }
    let record: ApiKeyRecord | null;
    try {
      record = await store.validate(token);
    } catch {
      res.status(503).json({ error: "API 키 검증에 실패했습니다. 잠시 후 다시 시도해주세요." });
      return;
    }
    if (!record) {
      res.status(401).json({ error: "유효하지 않은 API 키입니다." });
      return;
    }
    (res.locals as { apiKey?: ApiKeyRecord }).apiKey = record;
    store.recordUsage(record.id);
    next();
  };
}

/**
 * rate limiter.
 *   - 키 모드: 검증된 키별로 그 키의 rate_per_min 한도를 적용.
 *   - 비키 모드(로컬/테스트): IP별 기본 한도. XFF 없는 내부 호출은 제외.
 */
function createRateLimiter(keyMode: boolean, defaultPerMin: number): RateLimitRequestHandler {
  return rateLimit({
    windowMs: 60_000,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    validate: false,
    limit: (_req: Request, res: Response): number =>
      keyMode ? (getApiKey(res)?.ratePerMin ?? defaultPerMin) : defaultPerMin,
    // 비키 모드에서만 내부(XFF 없는) 호출을 제외한다. 키 모드는 키 단위로 센다.
    skip: (req: Request): boolean => (keyMode ? false : !req.headers["x-forwarded-for"]),
    keyGenerator: (req: Request, res: Response): string => {
      const key = getApiKey(res);
      if (key) return `key:${key.id}`;
      const xff = req.headers["x-forwarded-for"];
      const raw = Array.isArray(xff) ? (xff[0] ?? "") : (xff ?? "");
      return raw.split(",")[0]?.trim() || req.ip || "unknown";
    },
  });
}

/** 프록시(Caddy) 뒤에서 클라이언트 IP를 뽑는다(XFF 첫 항목 우선). */
function clientIp(req: Request): string {
  const xff = req.headers["x-forwarded-for"];
  const raw = Array.isArray(xff) ? (xff[0] ?? "") : (xff ?? "");
  return raw.split(",")[0]?.trim() || req.ip || "unknown";
}

/**
 * 공개 셀프 발급 라우터. 인증 없이 누구나 키를 발급받는다(공개 API).
 *   POST /keys  { name? } → 원본 키 1회 반환
 * 남용 방지: IP당 시간당 발급 횟수를 제한하고, 발급 키의 기본 한도를 낮게 둔다.
 * (고한도 키는 관리자 발급(/admin/keys)으로만 가능)
 */
function createSelfIssueRouter(
  store: ApiKeyStore,
  ratePerMin: number,
  maxPerHourPerIp: number,
): Router {
  const router = Router();

  const issueLimiter = rateLimit({
    windowMs: 60 * 60_000, // 1시간
    limit: maxPerHourPerIp,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    validate: false,
    keyGenerator: (req: Request): string => clientIp(req),
    message: { error: "발급 한도를 초과했습니다. 잠시 후 다시 시도해주세요." },
  });

  router.post("/keys", issueLimiter, async (req: Request, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as { name?: unknown };
    const name =
      typeof body.name === "string" && body.name.trim() ? body.name.trim() : "self-issued";
    // 셀프 발급은 한도를 사용자가 정할 수 없다(서버 기본값 고정).
    const { id, rawKey } = await store.issue(name, ratePerMin);
    res.status(201).json({
      id,
      name,
      rate_per_min: ratePerMin,
      api_key: rawKey,
      note: "api_key는 지금만 표시됩니다. 안전한 곳에 보관하세요(서버는 해시만 저장).",
    });
  });

  return router;
}

/**
 * 관리자 발급/폐기 라우터. ADMIN_API_TOKEN으로 보호한다.
 *   POST   /admin/keys        { name, rate_per_min? } → 원본 키 1회 반환
 *   GET    /admin/keys        키 목록(원본 키 미포함)
 *   DELETE /admin/keys/:id    키 폐기
 */
function createAdminRouter(store: ApiKeyStore, adminToken: string): Router {
  const router = Router();

  router.use((req: Request, res: Response, next: NextFunction): void => {
    if (extractToken(req) !== adminToken) {
      res.status(401).json({ error: "관리자 인증에 실패했습니다." });
      return;
    }
    next();
  });

  router.post("/keys", async (req: Request, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as { name?: unknown; rate_per_min?: unknown };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      res.status(400).json({ error: "name(키 소유자/용도)이 필요합니다." });
      return;
    }
    const ratePerMin = Number(body.rate_per_min ?? 120);
    const { id, rawKey } = await store.issue(name, ratePerMin);
    res.status(201).json({
      id,
      name,
      rate_per_min: ratePerMin,
      api_key: rawKey,
      note: "api_key는 지금만 표시됩니다. 안전한 곳에 보관하세요(서버는 해시만 저장).",
    });
  });

  router.get("/keys", async (_req: Request, res: Response): Promise<void> => {
    res.json(await store.list());
  });

  router.delete("/keys/:id", async (req: Request, res: Response): Promise<void> => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "유효한 키 id가 필요합니다." });
      return;
    }
    res.json({ revoked: await store.revoke(id) });
  });

  return router;
}

/**
 * Express 앱을 구성한다 (테스트에서 서버 기동 없이 재사용 가능).
 * @param engine 초기화된 검색 엔진
 * @param opts   설정/키 저장소 (생략 시 보호·키 인증 없이 동작)
 */
export function createApp(engine: SearchEngine, opts: CreateAppOptions = {}): express.Express {
  const { config, apiKeyStore = null, usageLog = null } = opts;

  // fail-closed 불변식: 키 필수인데 저장소가 없으면 무인증 개방을 막기 위해 기동을 거부한다.
  if (config?.apiKeys.required && !apiKeyStore) {
    throw new Error("apiKeys.required=true이면 apiKeyStore가 반드시 필요합니다(무인증 개방 방지).");
  }
  const keyMode = Boolean(config?.apiKeys.required && apiKeyStore);

  const app = express();
  app.use(express.json());

  // 헬스체크 (인증·rate limit·동시성 제외 — 모니터링용)
  app.get("/health", async (_req: Request, res: Response): Promise<void> => {
    const ok = await engine.health();
    res.status(ok ? 200 : 503).json({ status: ok ? "ok" : "unavailable" });
  });

  // 발급/폐기 엔드포인트 (관리자 토큰 보호). 키 저장소 + 관리자 토큰 있을 때만.
  if (apiKeyStore && config?.apiKeys.adminToken) {
    app.use("/admin", createAdminRouter(apiKeyStore, config.apiKeys.adminToken));
  }

  // 공개 셀프 발급(POST /keys). 인증 체인 "앞"에 마운트해 키 없이 접근 가능하게 한다.
  if (keyMode && apiKeyStore && config?.apiKeys.selfIssue.enabled) {
    app.use(
      createSelfIssueRouter(
        apiKeyStore,
        config.apiKeys.selfIssue.ratePerMin,
        config.apiKeys.selfIssue.maxPerHourPerIp,
      ),
    );
  }

  // 검색/문서 라우트 체인: 키 인증 → rate-limit → 동시성 → 타임아웃 → 라우트.
  // (무효 키·한도 초과 요청은 비싼 동시성 슬롯/검색을 점유하기 전에 먼저 걸러진다)
  const chain: RequestHandler[] = [];
  if (keyMode && apiKeyStore) chain.push(createApiKeyAuth(apiKeyStore));
  chain.push(createRateLimiter(keyMode, keyMode ? 120 : 60));
  if (config) {
    chain.push(createConcurrencyLimiter(config.protection.maxConcurrent));
    chain.push(createTimeout(config.protection.requestTimeoutMs));
  }

  const cache = config
    ? createRouteCache(config.protection.cacheMaxEntries, config.protection.cacheTtlMs)
    : undefined;
  app.use("/", ...chain, createSearchRouter(engine, cache, usageLog ?? undefined));

  return app;
}

/**
 * 서버를 기동한다.
 */
export async function startServer(): Promise<void> {
  const config = loadConfig();
  // 크롤 폴백이 켜져 있으면 엔진을 래핑한다(REST 서버 경로에서만).
  const engine = await maybeWrapCrawlFallback(await createSearchEngine(config), config);
  await engine.init();

  // 운영(키 필수)일 때만 영속 저장소(MySQL)를 준비한다.
  // 검색 데이터는 SQLite(덤프)지만, API 키·사용 로그는 영속성을 위해 MySQL에 둔다.
  let apiKeyStore: ApiKeyStore | null = null;
  let usageLog: UsageLogStore | null = null;
  if (config.apiKeys.required) {
    const store = await createApiKeyStore(config);
    await store.init();
    apiKeyStore = store;
    if (!config.apiKeys.adminToken) {
      console.error(
        "[api] 경고: ADMIN_API_TOKEN 미설정 → 발급 엔드포인트(/admin/keys)가 비활성화됩니다.",
      );
    }
    // 사용 로그도 MySQL에 적재한다.
    const ul = await createUsageLogStore(config);
    await ul.init();
    usageLog = ul;
  }

  const app = createApp(engine, { config, apiKeyStore, usageLog });

  app.listen(config.apiPort, () => {
    console.error(
      `[api] REST API 서버 실행 중: http://localhost:${config.apiPort} ` +
        `(엔진: ${config.searchEngine}, API키: ${config.apiKeys.required ? "필수" : "비활성"}, ` +
        `크롤폴백: ${config.crawl.enabled ? (config.crawl.appendDump ? "on+덤프" : "on(인덱스전용)") : "off"})`,
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
