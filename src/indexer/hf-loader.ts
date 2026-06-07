/**
 * HuggingFace 데이터셋 로더.
 *
 * 두 가지 방식을 제공한다:
 *   1) loadHuggingFaceParquet — parquet 파일을 HTTP Range로 부분 읽어 스트리밍 (대량 인덱싱 권장)
 *   2) loadHuggingFace        — datasets-server rows API 페이지네이션 (소량/간편)
 *
 * 권장 데이터셋: heegyu/namuwiki-extracted (마크업 제거 정제본)
 */

import {
  asyncBufferFromUrl,
  parquetReadObjects,
  parquetMetadataAsync,
} from "hyparquet";
import { compressors } from "hyparquet-compressors";
import type { NamuDocument } from "../types/index.js";

/** datasets-server rows API의 length 상한 (한 번에 최대 100행) */
const PAGE_SIZE = 100;

/** heegyu/namuwiki-extracted의 기본 parquet 파일 URL (단일 파일, 약 2.2GB) */
const DEFAULT_PARQUET_URL =
  "https://huggingface.co/datasets/heegyu/namuwiki-extracted/resolve/refs%2Fconvert%2Fparquet/default/train/0000.parquet";

/** parquet에서 한 번에 읽어올 행 청크 크기 (메모리 폭증 방지) */
const PARQUET_CHUNK = 10240;

/**
 * parquet 한 행(원본)을 NamuDocument로 정규화한다.
 *
 * 이 데이터셋의 특이점:
 *   - contributors는 배열이 아니라 콤마로 구분된 문자열이다.
 *   - namespace는 빈 문자열인 경우가 많다 → "문서"로 정규화한다.
 */
function normalizeParquetRow(row: Record<string, unknown>): NamuDocument {
  const rawContributors = row.contributors;
  const contributors = Array.isArray(rawContributors)
    ? rawContributors.map((c) => String(c))
    : typeof rawContributors === "string"
      ? rawContributors.split(",").map((s) => s.trim()).filter(Boolean)
      : [];

  const rawNs = row.namespace;
  const namespace =
    typeof rawNs === "string" && rawNs.trim() ? rawNs : "문서";

  return {
    namespace,
    title: typeof row.title === "string" ? row.title : String(row.title ?? ""),
    text: typeof row.text === "string" ? row.text : "",
    contributors,
  };
}

/**
 * parquet 파일을 NamuDocument 스트림으로 변환한다.
 *
 * hyparquet의 asyncBufferFromUrl + rowStart/rowEnd를 이용해
 * 파일 전체를 내려받지 않고 필요한 row group만 HTTP Range로 읽는다.
 * 따라서 호출 측에서 limit으로 조기 종료하면 그만큼만 다운로드한다.
 *
 * @param options parquet URL 등
 * @returns NamuDocument를 하나씩 내보내는 async generator
 */
export async function* loadHuggingFaceParquet(
  options: { parquetUrl?: string; startRow?: number } = {},
): AsyncGenerator<NamuDocument> {
  const url = options.parquetUrl ?? DEFAULT_PARQUET_URL;

  const file = await asyncBufferFromUrl({ url });
  const meta = await parquetMetadataAsync(file);
  const total = Number(meta.num_rows);

  // startRow가 주어지면 그 행부터 읽어 이미 색인된 앞부분을 건너뛴다.
  const begin = options.startRow && options.startRow > 0 ? options.startRow : 0;

  // 청크 단위로 읽어 yield한다. 호출 측이 break하면 다음 청크는 읽지 않는다.
  for (let start = begin; start < total; start += PARQUET_CHUNK) {
    const end = Math.min(start + PARQUET_CHUNK, total);
    const rows = (await parquetReadObjects({
      file,
      compressors,
      rowStart: start,
      rowEnd: end,
    })) as Array<Record<string, unknown>>;

    for (const row of rows) {
      if (typeof row.title !== "string" || !row.title) continue;
      yield normalizeParquetRow(row);
    }
  }
}

export interface HfLoaderOptions {
  /** 데이터셋 이름 (기본 heegyu/namuwiki-extracted) */
  dataset?: string;
  /** config 이름 (기본 default) */
  config?: string;
  /** split 이름 (기본 train) */
  split?: string;
}

interface RowsResponse {
  rows: Array<{ row_idx: number; row: Record<string, unknown> }>;
  num_rows_total?: number;
}

/**
 * HuggingFace 데이터셋을 NamuDocument 스트림으로 변환한다.
 *
 * @param options 데이터셋/스플릿 지정
 * @returns NamuDocument를 하나씩 내보내는 async generator
 */
export async function* loadHuggingFace(
  options: HfLoaderOptions = {},
): AsyncGenerator<NamuDocument> {
  const dataset = options.dataset ?? "heegyu/namuwiki-extracted";
  const config = options.config ?? "default";
  const split = options.split ?? "train";

  let offset = 0;
  let total = Infinity;

  while (offset < total) {
    const url =
      `https://datasets-server.huggingface.co/rows` +
      `?dataset=${encodeURIComponent(dataset)}` +
      `&config=${encodeURIComponent(config)}` +
      `&split=${encodeURIComponent(split)}` +
      `&offset=${offset}&length=${PAGE_SIZE}`;

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(
        `HuggingFace rows API 요청 실패 (${res.status}): ${await res.text()}`,
      );
    }

    const data = (await res.json()) as RowsResponse;
    if (data.num_rows_total != null) total = data.num_rows_total;
    if (!data.rows || data.rows.length === 0) break;

    for (const { row } of data.rows) {
      const title = row.title;
      if (typeof title !== "string") continue;
      yield {
        namespace: typeof row.namespace === "string" ? row.namespace : "문서",
        title,
        text: typeof row.text === "string" ? row.text : "",
        contributors: Array.isArray(row.contributors)
          ? (row.contributors as string[])
          : [],
      };
    }

    offset += data.rows.length;
  }
}
