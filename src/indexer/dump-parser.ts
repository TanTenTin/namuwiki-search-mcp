/**
 * 나무위키 공식 JSON 덤프 스트리밍 파서.
 *
 * 덤프는 12GB 이상이므로 전체를 메모리에 올리지 않고
 * stream-json의 StreamArray로 한 건씩 스트리밍 파싱한다.
 *
 * 덤프 형식: 최상위가 문서 객체의 배열인 JSON.
 *   [ { "namespace": ..., "title": ..., "text": ..., "contributors": [...] }, ... ]
 */

import { createReadStream } from "node:fs";
import StreamJson from "stream-json";
import StreamArrayMod from "stream-json/streamers/StreamArray.js";
import type { NamuDocument } from "../types/index.js";

// stream-json은 CJS 패키지다. ESM에서는 default import 후
// 속성(.parser / .streamArray)으로 팩토리 함수를 꺼내 쓴다.
const parser = (StreamJson as unknown as { parser: () => any }).parser;
const streamArray = (StreamArrayMod as unknown as { streamArray: () => any }).streamArray;

/**
 * 덤프 JSON 파일을 NamuDocument 스트림으로 변환한다.
 *
 * @param filePath 덤프 JSON 파일 경로
 * @returns NamuDocument를 하나씩 내보내는 async generator
 */
export async function* parseDump(filePath: string): AsyncGenerator<NamuDocument> {
  const pipeline = createReadStream(filePath)
    .pipe(parser())
    .pipe(streamArray());

  // StreamArray는 { key, value } 형태로 각 배열 요소를 내보낸다.
  for await (const chunk of pipeline as AsyncIterable<{ key: number; value: unknown }>) {
    const value = chunk.value as Partial<NamuDocument>;
    if (!value || typeof value.title !== "string") continue;

    yield {
      namespace: value.namespace ?? "문서",
      title: value.title,
      text: value.text ?? "",
      contributors: value.contributors ?? [],
    };
  }
}
