/**
 * 프로젝트 전역에서 공유하는 TypeScript 타입 정의.
 */

/**
 * 나무위키 문서 한 건의 원본 형태.
 * 덤프 JSON 및 HuggingFace 데이터셋의 한 레코드와 대응한다.
 */
export interface NamuDocument {
  /** 네임스페이스 (예: "문서", "틀", "분류"). 일반 문서는 보통 "문서". */
  namespace: string;
  /** 문서 제목 */
  title: string;
  /** 나무위키 마크업 원문 */
  text: string;
  /** 기여자 목록 */
  contributors: string[];
}

/**
 * 검색 엔진에 인덱싱되는 문서 형태.
 * 원문(text_raw)과 마크업이 제거된 정제 텍스트(text)를 함께 보관한다.
 */
export interface IndexedDocument {
  /** 안정적인 문서 식별자 (제목 기반 해시 또는 정규화된 제목) */
  id: string;
  namespace: string;
  title: string;
  /** 마크업이 제거된 정제 텍스트 (검색/스니펫 대상) */
  text: string;
  /** 마크업 원문 */
  text_raw: string;
  contributors: string[];
}

/**
 * 단건 검색 결과.
 */
export interface SearchResult {
  title: string;
  /** 검색어 주변 텍스트 발췌 (최대 300자) */
  snippet: string;
  /** 관련도 점수 (엔진마다 스케일이 다를 수 있음. 높을수록 관련도 높음) */
  score: number;
}

/**
 * 검색 응답.
 */
export interface SearchResponse {
  results: SearchResult[];
  total: number;
}

/**
 * 문서 단건 조회 응답.
 */
export interface ArticleResponse {
  title: string;
  /** 본문. plain_text=true면 마크업 제거본, false면 원문. */
  text: string;
  contributors: string[];
  found: boolean;
  /**
   * 결과 출처(선택). 크롤 폴백이 켜져 있을 때만 채워진다.
   *   - "dump": 덤프/인덱스에서 찾음
   *   - "crawled": 인덱스에 없어 나무위키에서 실시간 크롤로 가져옴
   * 폴백 미사용 경로와의 호환을 위해 선택 필드로 둔다.
   */
  source?: "dump" | "crawled";
}

/**
 * 검색 옵션.
 */
export interface SearchOptions {
  /** 결과 수 (기본 5, 최대 20) */
  limit?: number;
  /** 네임스페이스 필터 */
  namespace?: string;
}
