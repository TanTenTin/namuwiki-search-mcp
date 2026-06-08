/**
 * API 키 저장소 추상화.
 *
 * 검색 엔진과 마찬가지로 인터페이스를 두어, 저장 백엔드(MySQL/SQLite)를
 * 바꿔도 API 레이어(server.ts)를 수정하지 않는다.
 *
 * 공통 정책:
 *   - 키 원본은 저장하지 않고 SHA-256 해시만 보관(발급 시 1회만 원본 노출).
 *   - 검증 결과는 짧은 TTL로 인메모리 캐시.
 *   - 사용량은 인메모리로 모아 주기적으로 일괄 반영.
 */

import crypto from "node:crypto";

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

/** API 키 저장소 인터페이스. MySQL/SQLite 구현이 이를 따른다. */
export interface ApiKeyStore {
  /** 연결 수립 + 테이블 생성 + 사용량 flush 타이머 시작. */
  init(): Promise<void>;
  /** 키 원본을 검증해 레코드를 반환한다(무효면 null). */
  validate(rawKey: string): Promise<ApiKeyRecord | null>;
  /** 새 키를 발급하고 원본 키를 반환한다(이후엔 해시만 남는다). */
  issue(name: string, ratePerMin: number): Promise<{ id: number; rawKey: string }>;
  /** 키를 비활성화(폐기)한다. */
  revoke(id: number): Promise<boolean>;
  /** 발급된 키 목록(원본 키는 포함하지 않음). */
  list(): Promise<ApiKeySummary[]>;
  /** 사용량 1건을 인메모리에 누적한다(즉시 DB에 쓰지 않음). */
  recordUsage(id: number): void;
  /** 자원 정리(타이머 해제, 잔여 사용량 반영, 연결 종료). */
  close(): Promise<void>;
}

/** 사용량 일괄 반영 주기(ms). 구현체가 공통으로 사용. */
export const USAGE_FLUSH_INTERVAL_MS = 30_000;

/** 새 API 키 원본을 생성한다 (nw_ 접두사 + base64url 랜덤). */
export function generateRawKey(): string {
  return `nw_${crypto.randomBytes(24).toString("base64url")}`;
}

/** 키 원본을 SHA-256 해시(hex)로 변환한다. */
export function hashKey(rawKey: string): string {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}
