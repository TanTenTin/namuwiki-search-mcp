/**
 * 검색 결과 재정렬(re-ranking) 유틸. 엔진 공통으로 사용한다.
 *
 * 검색 엔진(BM25/rankingScore)은 본문 내 키워드 빈도를 관련도로 보기 때문에,
 * 제목이 검색어와 완전히 일치하는 "대표 문서"가 키워드를 많이 반복하는 긴 하위
 * 문서에 밀리는 문제가 있다. (예: "아이유" 검색 시 본문서가 아니라 "아이유/CF",
 * "아이유/콘서트/세트리스트" 등이 상위를 차지)
 *
 * 해결 전략: 엔진에서 후보를 넉넉히 과다 조회(over-fetch)한 뒤, 아래 신호로 티어를
 * 매겨 안정 정렬한다. 엔진의 원 점수 순서는 같은 티어 안에서 그대로 보존한다.
 *   - 제목 완전 일치 → 최상단              (요구사항 [1])
 *   - 하위 문서("제목/하위")는 대표 문서 뒤 (요구사항 [4])
 */

export interface Rankable {
  title: string;
}

/** 제목/검색어 정규화: 소문자화 + 연속 공백 축소 + trim. (BTS/bts 같은 라틴 표기 일치용) */
export function normalizeTitle(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * 제목 매칭 티어를 계산한다. 값이 작을수록 관련도가 높다.
 *   0: 제목 완전 일치 (예: query="아이유", title="아이유"). 별칭의 정식 제목도 완전일치로 취급.
 *   1: 하위 문서인데 상위 경로가 검색어와 일치 (예: query="손흥민", title="손흥민/2018-19 시즌")
 *   2: 제목에 검색어가 부분 포함 (예: query="아이유", title="아이유 갤러리")
 *   3: 그 외 (본문에서만 매칭)
 *
 * @param ncanon 별칭의 정식 제목(정규화됨). 검색어가 별칭일 때만 지정된다.
 */
function titleTier(title: string, nq: string, ncanon: string | null): number {
  const nt = normalizeTitle(title);
  if (nt === nq || (ncanon !== null && nt === ncanon)) return 0;
  // 하위 문서 경로의 최상위 조각만 떼어 비교한다.
  const base = nt.split("/")[0].trim();
  if (base === nq || (ncanon !== null && base === ncanon)) return 1;
  if ((nq.length > 0 && nt.includes(nq)) || (ncanon !== null && nt.includes(ncanon))) return 2;
  return 3;
}

/**
 * 엔진이 돌려준 후보 목록을 재정렬해 상위 limit개를 반환한다.
 *
 * 정렬 기준(우선순위 순):
 *   1) 제목 티어(작을수록 우선)          — [1] 완전일치 부스팅
 *   2) 하위 문서 여부(대표 문서 우선)     — [4] 하위 문서 페널티
 *   3) 엔진 원 순서(동일 조건 내 관련도 보존, 안정 정렬)
 *
 * @param hits      엔진 점수 내림차순으로 정렬된 후보(과다 조회한 풀)
 * @param query     사용자 검색어
 * @param limit     최종 반환 개수
 * @param canonical 검색어가 별칭일 때의 정식 제목(예: "BTS"→"방탄소년단"). 없으면 null.
 */
export function rerankHits<T extends Rankable>(
  hits: T[],
  query: string,
  limit: number,
  canonical: string | null = null,
): T[] {
  const nq = normalizeTitle(query);
  const ncanon = canonical !== null ? normalizeTitle(canonical) : null;

  const decorated = hits.map((hit, index) => {
    const nt = normalizeTitle(hit.title);
    return {
      hit,
      index,
      tier: titleTier(hit.title, nq, ncanon),
      // query 자체에 "/"가 있으면 하위 문서 지정 의도이므로 페널티를 주지 않는다.
      isSub: nt.includes("/") && !nq.includes("/"),
    };
  });

  decorated.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    // 같은 티어면 하위 문서를 대표 문서보다 뒤로 ([4])
    if (a.isSub !== b.isSub) return a.isSub ? 1 : -1;
    // 그 외에는 엔진 원 순서를 유지 (안정 정렬)
    return a.index - b.index;
  });

  return decorated.slice(0, limit).map((d) => d.hit);
}

/**
 * 과다 조회할 후보 풀 크기를 계산한다.
 *
 * 재정렬로 대표 문서를 끌어올리려면 그 문서가 애초에 후보 안에 있어야 한다.
 * 요청 limit의 배수로 넉넉히 잡되, 과도한 조회를 막기 위해 상한을 둔다.
 */
export function poolSizeFor(limit: number): number {
  return Math.min(Math.max(limit * 8, 40), 60);
}
