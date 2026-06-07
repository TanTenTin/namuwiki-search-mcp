/**
 * 나무위키 마크업 간이 정제 유틸.
 *
 * 프로젝트 규칙: 마크업 완전 파싱은 하지 않는다.
 * 검색 및 스니펫 생성에 필요한 수준으로 주요 패턴만 정규식으로 제거한다.
 */

/**
 * 나무위키 마크업을 제거하여 평문에 가깝게 정제한다.
 *
 * 처리 대상 (대표 패턴):
 * - [[링크|표시텍스트]] → 표시텍스트 (또는 링크)
 * - {{{#색상 텍스트}}}, {{{+1 텍스트}}} 등 글꼴/색 지정 → 내부 텍스트
 * - [include(...)], [[파일:...]], [각주] 매크로 → 제거
 * - '''굵게''', ''기울임'', __밑줄__, ~~취소선~~ 등 강조 → 기호 제거
 * - == 제목 ==, * 목록 등 줄 단위 마크업 → 기호 제거
 *
 * @param raw 마크업 원문
 * @returns 정제된 평문
 */
export function stripMarkup(raw: string): string {
  if (!raw) return "";

  let text = raw;

  // 1) include / 각주 매크로 등 대괄호 매크로 제거: [include(틀:...)], [각주], [* 내용]
  //    [* ... ] 형태의 각주는 내용까지 통째로 제거한다.
  text = text.replace(/\[\*[^\]]*\]/g, ""); // [* 각주내용]
  text = text.replace(/\[(?:include|목차|tableofcontents|각주|br|clearfix|pagecount)[^\]]*\]/gi, "");

  // 2) 파일/이미지 링크 제거: [[파일:...]], [[file:...]]
  text = text.replace(/\[\[(?:파일|file|분류|category):[^\]]*\]\]/gi, "");

  // 3) 일반 링크 [[대상|표시]] → 표시, [[대상]] → 대상
  text = text.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2");
  text = text.replace(/\[\[([^\]]+)\]\]/g, "$1");

  // 4) 색/글꼴 지정 블록 {{{#색 ...}}}, {{{+1 ...}}} → 내부 텍스트만 남김
  //    여러 번 반복해 중첩을 풀어준다.
  for (let i = 0; i < 5; i++) {
    const before = text;
    // {{{#16진색 텍스트}}} 또는 {{{+n 텍스트}}} 또는 {{{색이름 텍스트}}}
    text = text.replace(/\{\{\{(?:#[0-9a-zA-Z]+|\+\d|\-\d|[^\s{}]+)\s+([^{}]*)\}\}\}/g, "$1");
    // 그 외 남은 {{{ ... }}} (예: 코드블록)
    text = text.replace(/\{\{\{([^{}]*)\}\}\}/g, "$1");
    if (before === text) break;
  }

  // 5) 인용/접기 등 매크로성 중괄호 잔여물 제거
  text = text.replace(/\{\{\{|\}\}\}/g, "");

  // 6) 강조 기호 제거: '''굵게''', ''기울임'', __밑줄__, ~~취소선~~, --취소선--, ^^위첨자^^, ,,아래첨자,,
  text = text.replace(/'''''|'''|''/g, "");
  text = text.replace(/__|~~|\^\^|,,/g, "");

  // 7) 줄 단위 마크업: 제목(== ==), 목록(*, 1.), 인용(>), 구분선(----)
  text = text.replace(/^={1,6}\s*(.*?)\s*={1,6}\s*$/gm, "$1"); // == 제목 ==
  text = text.replace(/^-{4,}\s*$/gm, ""); // 구분선
  text = text.replace(/^\s*[*#]+\s?/gm, ""); // 목록 마커
  text = text.replace(/^\s*>+\s?/gm, ""); // 인용

  // 8) 표 구분 기호 || 제거
  text = text.replace(/\|\|/g, " ");

  // 9) HTML 태그 잔여물 제거
  text = text.replace(/<[^>]+>/g, "");

  // 10) 공백 정규화: 연속 공백/개행 축소
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}

/**
 * 검색어 주변 텍스트를 발췌하여 스니펫을 생성한다.
 *
 * 검색어가 본문에 있으면 그 위치를 중심으로, 없으면 본문 앞부분을 사용한다.
 *
 * @param text 정제된 본문
 * @param query 검색어
 * @param maxLength 스니펫 최대 길이 (기본 300)
 * @returns 스니펫 문자열
 */
export function makeSnippet(text: string, query: string, maxLength = 300): string {
  if (!text) return "";

  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;

  // 검색어 첫 토큰의 위치를 찾는다 (대소문자 무시)
  const firstToken = query.trim().split(/\s+/)[0] ?? "";
  const idx = firstToken
    ? normalized.toLowerCase().indexOf(firstToken.toLowerCase())
    : -1;

  if (idx < 0) {
    // 검색어가 없으면 앞부분 발췌
    return normalized.slice(0, maxLength).trimEnd() + "…";
  }

  // 검색어를 중심으로 앞뒤를 발췌
  const half = Math.floor((maxLength - firstToken.length) / 2);
  const start = Math.max(0, idx - half);
  const end = Math.min(normalized.length, idx + firstToken.length + half);

  let snippet = normalized.slice(start, end).trim();
  if (start > 0) snippet = "…" + snippet;
  if (end < normalized.length) snippet = snippet + "…";

  return snippet;
}
