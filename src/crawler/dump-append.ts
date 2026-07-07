/**
 * 크롤로 수집한 문서를 append-only JSONL 사이드카 파일에 누적한다.
 *
 * 원본 덤프(12GB 단일 JSON 배열)에 직접 append하는 것은 구조상 안전하지 않으므로
 * (배열 닫힘 `]` 처리·동시 쓰기 손상 위험), 별도 JSONL 파일에 한 줄씩 쌓는다.
 * 재인덱싱 시 `--source crawled`로 이 파일을 함께 색인하면 크롤 수집분이 영구 반영된다.
 *
 * 파일 포맷: 한 줄당 NamuDocument 하나(JSON).
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { NamuDocument } from "../types/index.js";

/**
 * 문서 한 건을 사이드카 파일에 append한다.
 * 프로세스 내 중복 append를 막기 위해 이미 기록한 제목을 메모리에 캐시한다.
 * (프로세스 간 중복은 재인덱싱의 id 기준 upsert로 흡수되므로 문제되지 않는다.)
 */
export class CrawledDumpAppender {
  private readonly appended = new Set<string>();

  constructor(private readonly filePath: string) {}

  /**
   * 문서를 JSONL 한 줄로 append한다. best-effort이며, 실패해도 예외를 던지지 않는다.
   * @returns 실제로 기록했으면 true, 이미 기록된 제목이면 false
   */
  async append(doc: NamuDocument): Promise<boolean> {
    if (this.appended.has(doc.title)) return false;
    this.appended.add(doc.title);

    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, JSON.stringify(doc) + "\n", "utf8");
      return true;
    } catch (err) {
      // 덤프 append 실패는 폴백 응답 자체를 막지 않는다(로그만 남긴다).
      console.error(
        "[crawler] 덤프 사이드카 기록 실패:",
        err instanceof Error ? err.message : String(err),
      );
      // 다음 요청에서 재시도할 수 있도록 캐시에서 되돌린다.
      this.appended.delete(doc.title);
      return false;
    }
  }
}
