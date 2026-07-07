/**
 * 인덱싱 CLI 스크립트.
 *
 * 데이터 소스를 선택해 검색 엔진에 색인한다.
 *
 * 사용법:
 *   npx tsx scripts/index-data.ts --source sample
 *   npx tsx scripts/index-data.ts --source dump --file ./data/namuwiki.json
 *   npx tsx scripts/index-data.ts --source huggingface [--dataset heegyu/namuwiki-extracted]
 *   (옵션) --limit 1000   : 색인할 최대 문서 수 (테스트용)
 *   (옵션) --batch 500    : 배치 크기
 *
 * 검색 엔진은 .env의 SEARCH_ENGINE에 따라 결정된다 (sqlite | meilisearch).
 */

import { loadConfig, createSearchEngine } from "../src/config.js";
import { runIndexing } from "../src/indexer/indexer.js";
import { parseDump } from "../src/indexer/dump-parser.js";
import { parseJsonl } from "../src/indexer/jsonl-parser.js";
import { loadHuggingFace, loadHuggingFaceParquet } from "../src/indexer/hf-loader.js";
import { MeilisearchEngine } from "../src/search/meilisearch.js";
import { MysqlSearchEngine } from "../src/search/mysql.js";
import type { NamuDocument } from "../src/types/index.js";

/** 간단한 --key value / --flag 인자 파서 */
function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const source = (args.source as string) ?? "sample";
  const batchSize = args.batch ? Number(args.batch) : undefined;
  const limit = args.limit ? Number(args.limit) : undefined;
  const throttleMs = args.throttle ? Number(args.throttle) : undefined;

  const config = loadConfig();
  const engine = await createSearchEngine(config);
  await engine.init();

  console.error(
    `[index] 소스: ${source} | 엔진: ${config.searchEngine}` +
      (limit ? ` | 제한: ${limit}건` : ""),
  );

  // 소스별로 NamuDocument 스트림을 만든다.
  let stream: AsyncIterable<NamuDocument>;
  switch (source) {
    case "sample":
      // 샘플은 덤프와 동일한 JSON 배열 형식이므로 덤프 파서를 재사용한다.
      stream = parseDump((args.file as string) ?? "./data/sample.json");
      break;
    case "dump":
      if (!args.file) throw new Error("--source dump 사용 시 --file <경로>가 필요합니다.");
      stream = parseDump(args.file as string);
      break;
    case "crawled":
      // 크롤 폴백이 누적한 사이드카(JSONL) 재인덱싱. id 기준 upsert라 중복 안전.
      stream = parseJsonl((args.file as string) ?? "./data/crawled.jsonl");
      break;
    case "huggingface":
      // 기본은 parquet 직접 스트리밍(HTTP Range, 대량 인덱싱 권장).
      // --method rows 를 주면 datasets-server rows API를 사용한다(소량/간편).
      if (args.method === "rows") {
        stream = loadHuggingFace({
          dataset: args.dataset as string | undefined,
          config: args.config as string | undefined,
          split: args.split as string | undefined,
        });
      } else {
        stream = loadHuggingFaceParquet({
          parquetUrl: args.url as string | undefined,
          startRow: args.skip ? Number(args.skip) : undefined,
        });
      }
      break;
    default:
      throw new Error(`알 수 없는 소스: ${source} (sample | dump | huggingface | crawled)`);
  }

  const start = Date.now();
  const total = await runIndexing(engine, stream, {
    batchSize,
    limit,
    throttleMs,
    onProgress: ({ indexed }) => {
      console.error(`[index] 진행: ${indexed}건 색인 완료`);
    },
  });

  // Meilisearch는 비동기 태스크 큐이므로 종료 전 완료를 기다린다.
  if (engine instanceof MeilisearchEngine) {
    console.error("[index] Meilisearch 인덱싱 태스크 완료 대기 중...");
    await engine.waitForIndexing();
  }

  // MySQL은 데이터 적재 후 FULLTEXT 인덱스를 한 번에 생성한다(I/O 효율).
  if (engine instanceof MysqlSearchEngine) {
    console.error("[index] MySQL FULLTEXT(ngram) 인덱스 생성 중... (오래 걸릴 수 있음)");
    const ftStart = Date.now();
    await engine.buildFulltextIndex();
    console.error(
      `[index] FULLTEXT 인덱스 생성 완료 (${((Date.now() - ftStart) / 1000).toFixed(1)}초)`,
    );
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.error(`[index] 완료: 총 ${total}건, ${elapsed}초 소요`);

  await engine.close?.();
}

main().catch((err) => {
  console.error("[index] 인덱싱 실패:", err);
  process.exit(1);
});
