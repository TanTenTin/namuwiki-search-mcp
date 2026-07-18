/**
 * 큐레이션 동의어(별칭) 맵.
 *
 * 현재 데이터셋(heegyu/namuwiki-extracted)은 리다이렉트 페이지(`#redirect 대상`)를
 * 제거한 정제본이라 덤프에서 별칭을 복원할 수 없다. 대신 자주 쓰이는 별칭을
 * 수작업으로 관리해, 쿼리 시점에 정식 문서 제목(canonical)으로 이어준다.
 *
 * 동작(각 엔진 search()에서):
 *   1) 별칭이면 정식 제목 문서를 title 인덱스로 직접 조회해 후보에 강제 주입한다.
 *   2) 재정렬(rerankHits)에서 정식 제목을 완전일치(티어0)로 취급해 최상단에 올린다.
 *
 * 확장 방법: 아래 SYNONYMS에 `"별칭": "정식 문서 제목"` 항목을 추가한다.
 *   - 값(정식 제목)은 반드시 데이터셋에 실제로 존재하는 문서 제목이어야 한다.
 *   - 키(별칭)는 대소문자/공백 차이를 무시하고 매칭된다.
 */

import { normalizeTitle } from "./rerank.js";

/** 별칭 → 정식 문서 제목. 값은 실제 존재하는 문서 제목이어야 한다. */
const SYNONYMS: Readonly<Record<string, string>> = {
  // K-POP / 인물 흔한 영문·약칭
  bts: "방탄소년단",
  防彈少年團: "방탄소년단",
  iu: "아이유",
  // 표기 흔들림/약칭 예시 (필요 시 계속 추가)
  블랙핑크: "BLACKPINK",
  삼전: "삼성전자",
};

/** 별칭 조회용 정규화 맵(대소문자/공백 무시). rerank와 동일한 정규화를 사용한다. */
const NORMALIZED: ReadonlyMap<string, string> = new Map(
  Object.entries(SYNONYMS).map(([alias, canonical]) => [normalizeTitle(alias), canonical]),
);

/**
 * 검색어가 알려진 별칭이면 정식 문서 제목을 돌려준다. 아니면 null.
 * @param query 사용자 검색어
 */
export function canonicalOf(query: string): string | null {
  return NORMALIZED.get(normalizeTitle(query)) ?? null;
}
