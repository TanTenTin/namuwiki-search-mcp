/**
 * 검색 엔진 추상화 레이어.
 *
 * 프로젝트 규칙: 새 검색 엔진을 추가해도 API/MCP 레이어를 수정하지 않도록
 * 모든 구현체는 이 인터페이스를 반드시 따른다.
 */

import type {
  IndexedDocument,
  SearchResponse,
  ArticleResponse,
  SearchOptions,
} from "../types/index.js";

export interface SearchEngine {
  /**
   * 엔진을 초기화한다 (연결 수립, 인덱스/테이블 생성 등).
   * 인덱싱과 검색 양쪽에서 사용 전에 한 번 호출한다.
   */
  init(): Promise<void>;

  /**
   * 문서 배치를 인덱싱한다.
   * @param docs 인덱싱할 문서 배열 (배치 단위)
   */
  index(docs: IndexedDocument[]): Promise<void>;

  /**
   * 키워드로 문서를 검색한다.
   * @param query 검색 키워드
   * @param options limit / namespace 등 옵션
   */
  search(query: string, options?: SearchOptions): Promise<SearchResponse>;

  /**
   * 제목으로 문서 한 건을 조회한다.
   * @param title 정확한 문서 제목
   * @param plainText true면 마크업 제거본, false면 원문을 반환
   */
  getArticle(title: string, plainText?: boolean): Promise<ArticleResponse>;

  /**
   * 엔진이 정상 동작하는지 확인한다 (헬스체크).
   * @returns 정상이면 true
   */
  health(): Promise<boolean>;

  /**
   * 자원을 정리한다 (연결 종료 등). 선택적.
   */
  close?(): Promise<void>;
}

/** 결과 수 기본값/상한 (MCP·REST 공통 정책) */
export const DEFAULT_LIMIT = 5;
export const MAX_LIMIT = 20;

/**
 * limit 값을 정책에 맞게 보정한다.
 */
export function normalizeLimit(limit?: number): number {
  if (!limit || limit < 1) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
}
