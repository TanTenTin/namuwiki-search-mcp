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

  // 9.5) 표/스타일/엔티티 등 놓치기 쉬운 잔재 추가 정제
  text = cleanupResidue(text);

  // 10) 공백 정규화: 연속 공백/개행 축소
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}

/**
 * stripMarkup이 놓치기 쉬운 잔재를 추가로 제거한다(베스트 에포트 정제).
 *
 * 실제 색인된 정제 텍스트에서도 아래 잔재가 스니펫에 노출되어 가독성을 해쳤다:
 *   - #!wiki / #!folding 등 인라인 디렉티브와 style="..." 속성
 *   - align= / width= / bgcolor= 등 표·스타일 속성 파편(공백 또는 & 로 구분)
 *   - {{{#색}}}의 이중 색상 지정 잔재 (예: "000,#e5e5e5", "#cc3d3d,#c13333")
 *   - 대괄호가 벗겨진 인라인 파일 링크 잔재 (예: "파일:아이콘.svg|width=15")
 *   - &nbsp; 등 HTML 엔티티
 *
 * stripMarkup 내부(향후 재색인 시 반영)와 makeSnippet 앞(기존 색인 즉시 개선)에서
 * 모두 호출한다. 이미 깨끗한 텍스트에는 대부분 무효과이며 멱등적으로 동작한다.
 */
export function cleanupResidue(text: string): string {
  if (!text) return "";
  let t = text;

  // 1) #!wiki, #!folding, #!html, #!syntax 등 디렉티브 토큰 제거
  t = t.replace(/#!\w+/g, " ");

  // 2) style="..." / style='...' 속성 제거
  t = t.replace(/\bstyle\s*=\s*("[^"]*"|'[^']*')/gi, " ");

  // 3) 대괄호가 벗겨진 인라인 파일/이미지 링크 잔재 제거: "파일:...확장자|옵션"
  //    옵션(|width=15 등)은 공백을 넘어 뒤 문장까지 삼키지 않도록 공백 전까지만 매칭한다.
  //    (속성 제거보다 먼저 처리해야 파일 토큰의 |옵션이 통째로 제거된다.)
  t = t.replace(
    /(?:파일|그림|file):[^|\]\n]*?\.(?:svg|png|jpe?g|gif|webp)(?:\|[^\s\]\n]+)*/gi,
    " ",
  );

  // 4) 표/스타일 속성 파편 제거: align=..., width=..., bgcolor=... 등 (선행 & 도 함께 제거)
  //    문자열 맨 앞에 오는 경우도 잡도록 \b 경계를 쓰고, 값은 공백/&/|/따옴표 전까지만 매칭한다.
  t = t.replace(
    /&?\b(?:align|width|height|bgcolor|color|rowspan|colspan|valign)\s*=\s*[^\s&|"']+/gi,
    " ",
  );

  // 5) 이중 색상 지정 잔재 제거: "#rrggbb,#rrggbb" 또는 "rrggbb,#rrggbb"
  t = t.replace(/#?[0-9a-fA-F]{3,8}\s*,\s*#[0-9a-fA-F]{3,8}/g, " ");
  // 단독 6자리 헥스 색상 잔재
  t = t.replace(/#[0-9a-fA-F]{6}\b/g, " ");

  // 6) HTML 엔티티: 공백류(nbsp 등)는 공백으로, 그 외 명명/숫자 엔티티는 제거
  t = t.replace(/&(?:nbsp|ensp|emsp|thinsp);/gi, " ");
  t = t.replace(/&#?\w+;/g, "");

  // 7) 공백 사이에 홀로 남은 표 구분 파이프(|) 정리
  t = t.replace(/(^|\s)\|(?=\s|$)/g, "$1");

  // 8) 공백 정리
  t = t.replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").trim();

  return t;
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

  // 이미 색인된 정제 텍스트에 남은 마크업/스타일 잔재를 스니펫 생성 전에 한 번 더 정제한다.
  // (재색인 없이도 스니펫 가독성이 즉시 개선된다.)
  const normalized = cleanupResidue(text).replace(/\s+/g, " ").trim();
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
