/**
 * MySQL 기반 유저 사용 로그 저장소.
 *
 * 검색·문서 조회 시 "어떤 키가 무엇을 언제 호출했는지"를 기록한다.
 * 검색 응답을 지연시키지 않도록 인메모리 버퍼에 모았다가 주기적으로 일괄 INSERT한다.
 * (로그 적재 실패는 검색 기능에 영향을 주지 않는다 — 조용히 버린다.)
 *
 * 검색 데이터(documents)는 SQLite(덤프, 재색인 가능)에 두지만, 사용 로그는
 * 영속 저장이 필요한 운영 데이터이므로 MySQL에 둔다.
 * (단 적재는 베스트에포트 — 일시 장애 시 해당 배치 로그는 버려질 수 있다. 검색은 막지 않는다.)
 */

import mysql from "mysql2/promise";
import type { MysqlConnectionConfig } from "../search/mysql.js";

export interface UsageLogEntry {
  /** 호출한 API 키 id (비키 모드면 null) */
  apiKeyId: number | null;
  /** 'search' | 'article' */
  endpoint: string;
  /** 검색어 또는 문서 제목 */
  query: string;
  /** 검색 결과 수(문서 조회는 발견 시 1, 미발견 0) */
  resultCount: number | null;
}

/** 버퍼 flush 주기(ms). */
const FLUSH_INTERVAL_MS = 5_000;
/** 버퍼가 이 크기에 도달하면 즉시 flush. */
const MAX_BUFFER = 500;

export class UsageLogStore {
  private pool: mysql.Pool | null = null;
  private buffer: UsageLogEntry[] = [];
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(private readonly conn: MysqlConnectionConfig) {}

  async init(): Promise<void> {
    this.pool = mysql.createPool({
      host: this.conn.host,
      port: this.conn.port,
      user: this.conn.user,
      password: this.conn.password,
      database: this.conn.database,
      charset: "utf8mb4",
      waitForConnections: true,
      connectionLimit: 3,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
    });

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS usage_logs (
        id           BIGINT AUTO_INCREMENT PRIMARY KEY,
        api_key_id   INT          NULL,
        endpoint     VARCHAR(16)  NOT NULL,
        query        VARCHAR(512) NOT NULL,
        result_count INT          NULL,
        created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_created (created_at),
        KEY idx_api_key (api_key_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    const timer = setInterval((): void => {
      void this.flush();
    }, FLUSH_INTERVAL_MS);
    timer.unref?.();
    this.flushTimer = timer;
  }

  /** 로그 1건을 버퍼에 넣는다(즉시 DB에 쓰지 않음 → 검색 응답을 막지 않음). */
  log(entry: UsageLogEntry): void {
    this.buffer.push(entry);
    if (this.buffer.length >= MAX_BUFFER) void this.flush();
  }

  /** 버퍼를 일괄 INSERT한다. */
  private async flush(): Promise<void> {
    if (this.buffer.length === 0 || !this.pool) return;
    const batch = this.buffer;
    this.buffer = [];
    // mysql2 bulk insert: VALUES ? 에 중첩 배열을 넘긴다.
    const values = batch.map((e) => [
      e.apiKeyId,
      e.endpoint,
      // 코드포인트 단위로 절단(서로게이트 페어 보존 → lone surrogate로 인한 INSERT 실패 방지).
      [...e.query].slice(0, 512).join(""),
      e.resultCount,
    ]);
    try {
      await this.pool.query(
        `INSERT INTO usage_logs (api_key_id, endpoint, query, result_count) VALUES ?`,
        [values],
      );
    } catch {
      // 로그 적재 실패는 치명적이지 않다 — 버린다.
    }
  }

  async close(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.flush();
    await this.pool?.end();
    this.pool = null;
  }
}
