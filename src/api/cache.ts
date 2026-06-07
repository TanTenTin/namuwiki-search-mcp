/**
 * 응답 캐시용 경량 LRU(+TTL) 캐시.
 *
 * 외부 의존성 없이 Map의 삽입 순서를 이용해 LRU를 구현한다.
 *   - get: TTL 만료 시 제거. 적중 시 키를 맨 뒤로 옮겨 MRU로 표시.
 *   - set: 용량 초과 시 가장 오래된(맨 앞) 항목부터 제거.
 *
 * 소형 서버(RDS 부하·IOPS 절감)에서 반복 질의가 검색엔진을 거치지 않게 한다.
 */

import type { SearchResponse, ArticleResponse } from "../types/index.js";

interface Entry<V> {
  value: V;
  expiresAt: number;
}

export class TtlLruCache<V> {
  private readonly map = new Map<string, Entry<V>>();

  constructor(
    private readonly maxSize: number,
    private readonly ttlMs: number,
  ) {}

  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    // 적중 → MRU로 갱신(삭제 후 재삽입 = 맨 뒤로 이동)
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    // 용량 초과분 제거(가장 오래된 = 맨 앞부터)
    while (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}

/** 검색/문서 라우트용 캐시 묶음. */
export interface RouteCache {
  search: TtlLruCache<SearchResponse>;
  article: TtlLruCache<ArticleResponse>;
}

export function createRouteCache(maxSize: number, ttlMs: number): RouteCache {
  return {
    search: new TtlLruCache<SearchResponse>(maxSize, ttlMs),
    article: new TtlLruCache<ArticleResponse>(maxSize, ttlMs),
  };
}
