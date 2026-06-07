/**
 * MCP 서버 진입점.
 *
 * 두 가지 트랜스포트를 지원한다 (MCP_TRANSPORT 환경변수로 선택):
 *   - stdio : 로컬에서 Claude Desktop/Code가 직접 프로세스를 spawn (기본값)
 *   - http  : 원격 배포용. Streamable HTTP(stateless)로 노출하여
 *             Claude 클라이언트가 네트워크 너머로 연결한다.
 *
 * 노출 툴:
 *   - search_namuwiki        → REST API GET /search 호출
 *   - get_namuwiki_article   → REST API GET /article/:title 호출
 *
 * 검색 로직은 REST API에만 존재하고, 이 서버는 그 API를 호출하는 클라이언트다.
 */

import { randomUUID } from "node:crypto";
import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, type AppConfig } from "../config.js";
import {
  TOOL_DEFINITIONS,
  NamuApiClient,
  searchInputSchema,
  getArticleInputSchema,
} from "./tools.js";

/**
 * MCP Server 인스턴스를 구성한다.
 * 트랜스포트와 무관하게 동일한 서버/핸들러를 재사용한다.
 * @param config 앱 설정 (REST API 베이스 URL 사용)
 */
function createMcpServer(config: AppConfig): Server {
  const client = new NamuApiClient(config.mcp.apiBaseUrl);

  const server = new Server(
    { name: "namuwiki-search-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  // 툴 목록 응답
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown>,
    })),
  }));

  // 툴 호출 처리
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      if (name === "search_namuwiki") {
        const input = searchInputSchema.parse(args);
        const result = await client.search(input);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      if (name === "get_namuwiki_article") {
        const input = getArticleInputSchema.parse(args);
        const result = await client.getArticle(input);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      // 알 수 없는 툴
      return {
        isError: true,
        content: [{ type: "text", text: `알 수 없는 툴: ${name}` }],
      };
    } catch (err) {
      // 프로젝트 규칙: 에러는 isError:true로 MCP 규격에 맞게 반환
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `툴 실행 오류: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  });

  return server;
}

/**
 * stdio 트랜스포트로 서버를 기동한다 (로컬 연동).
 */
async function startStdio(config: AppConfig): Promise<void> {
  const server = createMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stdout은 MCP 프로토콜 전용이므로 로그는 stderr로 출력한다.
  console.error(
    `[mcp] namuwiki-search-mcp 서버 시작 (stdio, REST API: ${config.mcp.apiBaseUrl})`,
  );
}

/**
 * Streamable HTTP 트랜스포트로 서버를 기동한다 (원격 배포).
 *
 * stateless 모드: 요청마다 새 Server/Transport를 생성해 처리한다.
 * 세션 상태를 서버에 두지 않으므로 Caddy 같은 리버스 프록시 뒤에서 단순하게 동작한다.
 * 외부 인증(Bearer 토큰 등)은 앞단 프록시(Caddy)에서 처리하는 것을 전제로 한다.
 */
async function startHttp(config: AppConfig): Promise<void> {
  const app = express();
  app.use(express.json());

  // 단순 헬스체크 (Caddy/모니터링용)
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // MCP 엔드포인트. POST로 JSON-RPC 메시지를 받는다.
  //  - "/mcp" : 로컬/직접 테스트용
  //  - "/"    : Caddy가 경로 prefix(/namuwiki)를 strip한 뒤 전달하는 운영 경로
  app.post(["/", "/mcp"], async (req, res) => {
    // 요청마다 독립 인스턴스 (stateless)
    const server = createMcpServer(config);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    // 응답이 끝나면 리소스 정리
    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.listen(config.mcp.httpPort, () => {
    console.error(
      `[mcp] namuwiki-search-mcp 서버 시작 (http, 포트: ${config.mcp.httpPort}, ` +
        `REST API: ${config.mcp.apiBaseUrl})`,
    );
  });
}

async function main(): Promise<void> {
  const config = loadConfig();

  if (config.mcp.transport === "http") {
    await startHttp(config);
  } else {
    await startStdio(config);
  }
}

main().catch((err) => {
  console.error("[mcp] 서버 시작 실패:", err);
  process.exit(1);
});
