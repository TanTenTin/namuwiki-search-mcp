/**
 * RDS(MySQL) 기반 API 키 저장소.
 *
 * 키 원본은 저장하지 않고 SHA-256 해시만 보관한다(발급 시 1회만 원본 노출).
 * 검증 결과는 짧은 TTL로 인메모리 캐시해 요청마다 DB를 때리지 않는다.
 * 사용량(요청 수/최근 사용 시각)은 인메모리로 모았다가 주기적으로 일괄 반영한다.
 */

import crypto from "node:crypto";
import mysql from "mysql2/promise";
import type { MysqlConnectionConfig } from "../search/mysql.js";

/** 검증/인증에 쓰는 최소 키 정보. */
export interface ApiKeyRecord {
  id: number;
  name: string;
  ratePerMin: number;
}

/** 목록 조회용 키 요약(원본 키는 포함하지 않음). */
export interface ApiKeySummary {
  id: number;
  name: string;
  ratePerMin: number;
  active: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  requestCount: number;
}

interface CacheEntry {
  /** null = 알려진 무효 키(부정 캐시) */
  record: ApiKeyRecord | null;
  expiresAt: number;
}

interface KeyRow {
  id: number;
  name: string;
  rate_per_min: number;
}

interface SummaryRow {
  id: number;
  name: string;
  rate_per_min: number;
  active: number;
  created_at: Date;
  last_used_at: Date | null;
  request_count: number;
}

const USAGE_FLUSH_INTERVAL_MS = 30_000;

export class ApiKeyStore {
  private pool: mysql.Pool | null = null;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly pendingUsage = new Map<number, number>();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly conn: MysqlConnectionConfig,
    private readonly cacheTtlMs = 60_000,
  ) {}

  async init(): Promise<void> {
    this.pool = mysql.createPool({
      host: this.conn.host,
      port: this.conn.port,
      user: this.conn.user,
      password: this.conn.password,
      database: this.conn.database,
      charset: "utf8mb4",
      waitForConnections: true,
      connectionLimit: 5,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
    });

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        key_hash      CHAR(64)     NOT NULL,
        name          VARCHAR(255) NOT NULL,
        rate_per_min  INT          NOT NULL DEFAULT 120,
        active        TINYINT(1)   NOT NULL DEFAULT 1,
        created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_used_at  TIMESTAMP    NULL,
        request_count BIGINT       NOT NULL DEFAULT 0,
        UNIQUE KEY uq_key_hash (key_hash)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 사용량 일괄 반영 타이머. 프로세스 종료를 막지 않도록 unref.
    const timer = setInterval((): void => {
      void this.flushUsage();
    }, USAGE_FLUSH_INTERVAL_MS);
    timer.unref?.();
    this.flushTimer = timer;
  }

  private ensurePool(): mysql.Pool {
    if (!this.pool) {
      throw new Error("ApiKeyStore가 초기화되지 않았습니다. init()을 먼저 호출하세요.");
    }
    return this.pool;
  }

  private static hash(rawKey: string): string {
    return crypto.createHash("sha256").update(rawKey).digest("hex");
  }

  /** 키 원본을 검증해 레코드를 반환한다(무효면 null). 결과는 캐시한다. */
  async validate(rawKey: string): Promise<ApiKeyRecord | null> {
    const keyHash = ApiKeyStore.hash(rawKey);
    const now = Date.now();
    const cached = this.cache.get(keyHash);
    if (cached && cached.expiresAt > now) return cached.record;

    const pool = this.ensurePool();
    const [rows] = await pool.query(
      `SELECT id, name, rate_per_min FROM api_keys WHERE key_hash = ? AND active = 1 LIMIT 1`,
      [keyHash],
    );
    const row = (rows as KeyRow[])[0];
    const record: ApiKeyRecord | null = row
      ? { id: row.id, name: row.name, ratePerMin: row.rate_per_min }
      : null;
    this.cache.set(keyHash, { record, expiresAt: now + this.cacheTtlMs });
    return record;
  }

  /** 새 키를 발급하고 원본 키를 반환한다(이후엔 해시만 남는다). */
  async issue(name: string, ratePerMin: number): Promise<{ id: number; rawKey: string }> {
    const rawKey = `nw_${crypto.randomBytes(24).toString("base64url")}`;
    const keyHash = ApiKeyStore.hash(rawKey);
    const pool = this.ensurePool();
    const [result] = await pool.query(
      `INSERT INTO api_keys (key_hash, name, rate_per_min) VALUES (?, ?, ?)`,
      [keyHash, name, ratePerMin],
    );
    return { id: (result as mysql.ResultSetHeader).insertId, rawKey };
  }

  /** 키를 비활성화(폐기)한다. 캐시는 즉시 비워 반영 지연을 없앤다. */
  async revoke(id: number): Promise<boolean> {
    const pool = this.ensurePool();
    const [result] = await pool.query(`UPDATE api_keys SET active = 0 WHERE id = ?`, [id]);
    this.cache.clear();
    return (result as mysql.ResultSetHeader).affectedRows > 0;
  }

  /** 발급된 키 목록(원본 키는 포함하지 않음). */
  async list(): Promise<ApiKeySummary[]> {
    const pool = this.ensurePool();
    const [rows] = await pool.query(
      `SELECT id, name, rate_per_min, active, created_at, last_used_at, request_count
       FROM api_keys ORDER BY id`,
    );
    return (rows as SummaryRow[]).map((r) => ({
      id: r.id,
      name: r.name,
      ratePerMin: r.rate_per_min,
      active: r.active === 1,
      createdAt: r.created_at.toISOString(),
      lastUsedAt: r.last_used_at ? r.last_used_at.toISOString() : null,
      requestCount: Number(r.request_count),
    }));
  }

  /** 사용량 1건을 인메모리에 누적한다(즉시 DB에 쓰지 않음). */
  recordUsage(id: number): void {
    this.pendingUsage.set(id, (this.pendingUsage.get(id) ?? 0) + 1);
  }

  /** 누적 사용량을 DB에 일괄 반영한다. */
  private async flushUsage(): Promise<void> {
    if (this.pendingUsage.size === 0 || !this.pool) return;
    const entries = Array.from(this.pendingUsage.entries());
    this.pendingUsage.clear();
    for (const [id, count] of entries) {
      try {
        await this.pool.query(
          `UPDATE api_keys SET request_count = request_count + ?, last_used_at = NOW() WHERE id = ?`,
          [count, id],
        );
      } catch {
        // 사용량 집계 실패는 치명적이지 않다 — 조용히 버린다.
      }
    }
  }

  async close(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.flushUsage();
    await this.pool?.end();
    this.pool = null;
  }
}
