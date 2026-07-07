/**
 * JSONL(한 줄당 JSON 하나) 스트리밍 파서.
 *
 * 크롤 폴백이 누적한 사이드카 파일(data/crawled.jsonl)을 재인덱싱할 때 사용한다.
 * 파일 전체를 메모리에 올리지 않고 라인 단위로 읽어 NamuDocument로 내보낸다.
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { NamuDocument } from "../types/index.js";

/**
 * JSONL 파일을 NamuDocument 스트림으로 변환한다.
 *
 * @param filePath JSONL 파일 경로
 * @returns NamuDocument를 하나씩 내보내는 async generator
 */
export async function* parseJsonl(filePath: string): AsyncGenerator<NamuDocument> {
  const rl = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // 손상된 라인 하나가 전체 인덱싱을 중단시키지 않도록 개별적으로 건너뛴다.
    let value: Partial<NamuDocument>;
    try {
      value = JSON.parse(trimmed) as Partial<NamuDocument>;
    } catch {
      continue;
    }
    if (typeof value.title !== "string") continue;

    yield {
      namespace: value.namespace ?? "문서",
      title: value.title,
      text: value.text ?? "",
      contributors: value.contributors ?? [],
    };
  }
}
