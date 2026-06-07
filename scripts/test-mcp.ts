/**
 * MCP 서버 엔드투엔드 스모크 테스트.
 *
 * 실제 MCP 서버 프로세스를 stdio로 띄워, JSON-RPC 핸드셰이크 →
 * tools/list → tools/call 을 수행하고, 그 호출이 REST API를 거쳐
 * 정상 응답을 돌려주는지 확인한다.
 *
 * 흐름:
 *   1) 이 프로세스 안에서 SQLite 기반 REST API를 임시 포트로 기동
 *   2) MCP 서버(tsx src/mcp/server.ts)를 자식 프로세스로 spawn
 *      (API_BASE_URL을 임시 포트로 주입)
 *   3) initialize → tools/list → tools/call(search_namuwiki) JSON-RPC 전송
 *   4) 응답 검증
 *
 * 실행: npx tsx scripts/test-mcp.ts
 */

import type { Server } from "node:http";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { SqliteSearchEngine } from "../src/search/sqlite.js";
import { runIndexing } from "../src/indexer/indexer.js";
import { parseDump } from "../src/indexer/dump-parser.js";
import { createApp } from "../src/api/server.js";

const DB_PATH = "./data/test-mcp.db";
const SAMPLE_PATH = "./data/sample.json";
const API_PORT = 3998;

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`, extra ?? "");
  }
}

/**
 * MCP 자식 프로세스와 JSON-RPC로 통신하는 최소 클라이언트.
 * stdio 트랜스포트는 줄바꿈으로 구분된 JSON 메시지를 주고받는다.
 */
class McpStdioClient {
  private buffer = "";
  private pending = new Map<number, (msg: any) => void>();
  private nextId = 1;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf-8");
      let idx: number;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id != null && this.pending.has(msg.id)) {
            this.pending.get(msg.id)!(msg);
            this.pending.delete(msg.id);
          }
        } catch {
          // JSON이 아닌 로그 줄은 무시
        }
      }
    });
  }

  /** 요청을 보내고 응답을 기다린다 */
  request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`타임아웃: ${method}`)), 15000);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.child.stdin.write(payload);
    });
  }

  /** 응답이 필요 없는 알림을 보낸다 */
  notify(method: string, params?: unknown): void {
    this.child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n",
    );
  }
}

async function main(): Promise<void> {
  console.log("=== MCP 서버 엔드투엔드 테스트 시작 ===\n");

  if (!existsSync(SAMPLE_PATH)) {
    throw new Error("샘플 데이터가 없습니다. 먼저 `npm run gen-sample`을 실행하세요.");
  }

  // 1) 임시 REST API 기동 (SQLite)
  console.log("[1] 임시 REST API 기동 + 샘플 색인");
  for (const ext of ["", "-wal", "-shm"]) {
    if (existsSync(DB_PATH + ext)) rmSync(DB_PATH + ext);
  }
  const engine = new SqliteSearchEngine(DB_PATH);
  await engine.init();
  await runIndexing(engine, parseDump(SAMPLE_PATH), { batchSize: 100 });
  const app = createApp(engine);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(API_PORT, () => resolve(s));
  });
  check("REST API 리스닝", server.listening);

  // 2) MCP 서버 spawn (API_BASE_URL 주입)
  console.log("\n[2] MCP 서버 프로세스 기동");
  const child = spawn("npx", ["tsx", "src/mcp/server.ts"], {
    env: {
      ...process.env,
      API_BASE_URL: `http://localhost:${API_PORT}`,
      MCP_TRANSPORT: "stdio",
    },
    shell: true, // Windows에서 npx 실행을 위해 shell 사용
  }) as ChildProcessWithoutNullStreams;

  child.stderr.on("data", (d: Buffer) => {
    // MCP 서버 로그는 stderr로 나온다 (디버깅용으로 흘려보냄)
    process.stderr.write(`    [mcp stderr] ${d.toString().trim()}\n`);
  });

  const client = new McpStdioClient(child);

  // 3) JSON-RPC 핸드셰이크
  console.log("\n[3] JSON-RPC 핸드셰이크");
  const initRes = await client.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test-mcp", version: "0.0.0" },
  });
  check("initialize 응답", initRes.result?.serverInfo?.name === "namuwiki-search-mcp", initRes.result?.serverInfo);
  client.notify("notifications/initialized");

  // 4) tools/list
  console.log("\n[4] tools/list");
  const toolsRes = await client.request("tools/list");
  const toolNames: string[] = (toolsRes.result?.tools ?? []).map((t: any) => t.name);
  check("search_namuwiki 노출", toolNames.includes("search_namuwiki"), toolNames);
  check("get_namuwiki_article 노출", toolNames.includes("get_namuwiki_article"), toolNames);

  // 5) tools/call → search_namuwiki (REST API를 거쳐 동작해야 함)
  console.log("\n[5] tools/call: search_namuwiki");
  const searchCall = await client.request("tools/call", {
    name: "search_namuwiki",
    arguments: { query: "타입스크립트", limit: 3 },
  });
  const searchText: string = searchCall.result?.content?.[0]?.text ?? "";
  const searchPayload = searchText ? JSON.parse(searchText) : {};
  check("search 결과 반환", (searchPayload.results?.length ?? 0) > 0, searchText.slice(0, 120));
  check("TypeScript 문서 포함", (searchPayload.results ?? []).some((r: any) => r.title === "TypeScript"));

  // 6) tools/call → get_namuwiki_article
  console.log("\n[6] tools/call: get_namuwiki_article");
  const articleCall = await client.request("tools/call", {
    name: "get_namuwiki_article",
    arguments: { title: "Meilisearch" },
  });
  const articleText: string = articleCall.result?.content?.[0]?.text ?? "";
  const articlePayload = articleText ? JSON.parse(articleText) : {};
  check("article found=true", articlePayload.found === true, articleText.slice(0, 120));

  // 정리
  child.kill();
  server.close();
  await engine.close?.();

  console.log(`\n=== 결과: ${passed} 통과, ${failed} 실패 ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("MCP 테스트 실행 중 오류:", err);
  process.exit(1);
});
