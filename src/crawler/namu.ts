/**
 * 나무위키 실시간 크롤러 (폴백 전용).
 *
 * 덤프/인덱스에 없는 문서를 요청받았을 때, 나무위키 페이지를 직접 가져와
 * 본문 텍스트를 추출한다. 프로젝트 규칙에 따라 완전 파싱은 하지 않고,
 * 검색/스니펫에 필요한 수준의 평문만 추출한다.
 *
 * 한계(설계상 인지된 리스크):
 *   - 나무위키는 Cloudflare 보호/동적 렌더링이 있어 단순 fetch가 차단되거나
 *     빈 셸 HTML만 받을 수 있다. 이 경우 null을 반환해 기존 found:false로 폴백된다.
 *   - 대상 URL은 설정으로 교체 가능하게 두어(미러/프록시) 운영에서 조정한다.
 */

import type { NamuDocument } from "../types/index.js";

/** 크롤러 설정 */
export interface CrawlerOptions {
  /** 요청 URL 템플릿. `{title}`가 URL 인코딩된 제목으로 치환된다. */
  urlTemplate: string;
  /** 요청 타임아웃(ms) */
  timeoutMs: number;
  /** 실패 시 재시도 횟수(지수 백오프) */
  retries: number;
}

/** 문서 미발견을 나타내는 나무위키 페이지의 대표 문구 */
const NOT_FOUND_MARKERS = [
  "문서를 찾을 수 없습니다",
  "해당 문서를 찾을 수 없습니다",
  "이 문서는 존재하지 않습니다",
];

/** 추출된 본문이 이보다 짧으면 유효 문서가 아니라고 본다(빈 셸/에러 페이지 방지). */
const MIN_TEXT_LENGTH = 20;

/**
 * 일시 오류(네트워크 끊김/5xx)에 견디는 fetch. hf-loader와 동일한 백오프 정책.
 * AbortController로 요청별 타임아웃을 건다.
 */
async function fetchWithRetry(
  url: string,
  timeoutMs: number,
  retries: number,
): Promise<Response | null> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        // 봇 차단을 조금이라도 피하고 정직하게 식별한다.
        headers: {
          "User-Agent": "namuwiki-search-mcp/1.0 (public-benefit; +https://namu.wiki)",
          Accept: "text/html",
        },
      });
      // 404 등 4xx는 재시도해도 소용없으므로 그대로 판단(미발견 처리).
      if (res.status >= 400 && res.status < 500) return res;
      // 5xx는 일시 오류로 보고 재시도.
      if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  // 재시도 소진: 크롤 실패로 간주하고 null(호출 측이 found:false로 폴백).
  void lastErr;
  return null;
}

/** 대표적인 HTML 엔티티만 최소 디코드한다. */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * HTML에서 본문 평문을 최소 추출한다.
 * script/style 블록을 통째로 제거하고, 태그를 벗긴 뒤 공백을 정규화한다.
 */
function extractText(html: string): string {
  let text = html;
  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  // 블록 경계에 개행을 넣어 문단이 붙어버리지 않게 한다.
  text = text.replace(/<\/(p|div|br|li|h[1-6])>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  text = decodeEntities(text);
  text = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

/**
 * 제목으로 나무위키 문서를 크롤링한다.
 *
 * @param title  정확한 문서 제목
 * @param opts   크롤러 설정
 * @returns 성공 시 NamuDocument, 미발견/차단/실패 시 null
 */
export async function fetchNamuArticle(
  title: string,
  opts: CrawlerOptions,
): Promise<NamuDocument | null> {
  const url = opts.urlTemplate.replace("{title}", encodeURIComponent(title));

  const res = await fetchWithRetry(url, opts.timeoutMs, opts.retries);
  if (!res || !res.ok) return null;

  const html = await res.text();
  if (NOT_FOUND_MARKERS.some((m) => html.includes(m))) return null;

  const text = extractText(html);
  if (text.length < MIN_TEXT_LENGTH) return null;

  // 크롤 수집분은 기여자 정보를 얻기 어렵고 네임스페이스도 일반 문서로 본다.
  return {
    namespace: "문서",
    title,
    text,
    contributors: [],
  };
}
