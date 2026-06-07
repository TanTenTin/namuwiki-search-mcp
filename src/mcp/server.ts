/**
 * MCP 서버 진입점.
 *
 * stdio 트랜스포트를 기본으로 하며, 두 개의 툴을 노출한다:
 *   - search_namuwiki        → REST API GET /search 호출
 *   - get_namuwiki_article   → REST API GET /article/:title 호출
 *
 * 검색 로직은 REST API에만 존재하고, 이 서버는 그 API를 호출하는 클라이언트다.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "../config.js";
import {
  TOOL_DEFINITIONS,
  NamuApiClient,
  searchInputSchema,
  getArticleInputSchema,
} from "./tools.js";

async function main(): Promise<void> {
  const config = loadConfig();
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

  // stdio 트랜스포트 연결.
  // (HTTP 트랜스포트는 향후 MCP_TRANSPORT=http로 확장 가능)
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stdout은 MCP 프로토콜 전용이므로 로그는 stderr로 출력한다.
  console.error(
    `[mcp] namuwiki-search-mcp 서버 시작 (REST API: ${config.mcp.apiBaseUrl})`,
  );
}

main().catch((err) => {
  console.error("[mcp] 서버 시작 실패:", err);
  process.exit(1);
});
