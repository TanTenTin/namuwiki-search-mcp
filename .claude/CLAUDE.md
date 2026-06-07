# namuwiki-search-mcp 프로젝트 지침

## 프로젝트 개요

나무위키 공식 검색 API가 없기 때문에, 나무위키 공개 데이터 덤프를 활용해
**검색 REST API**와 **MCP(Model Context Protocol) 서버**를 만드는 공익 오픈소스 프로젝트다.

### 핵심 목표
- 나무위키 덤프 데이터를 Meilisearch에 인덱싱
- 키워드 / 제목 검색 REST API 제공 (`GET /search`, `GET /article/:title`)
- Claude Code 등 AI 에이전트가 나무위키를 검색할 수 있는 MCP 서버 제공
- 공익 목적이므로 출처 표기 및 크레딧 준수

---

## 데이터 소스

### 나무위키 공식 덤프
- 배포 위치: https://namu.wiki/special/export (비공개, 직접 다운로드)
- 형식: JSON (압축 해제 시 ~12GB)
- 구조:
  ```json
  {
    "namespace": "문자열",
    "title": "문자열",
    "text": "나무위키 마크업 문법 원문",
    "contributors": ["기여자 목록"]
  }
  ```

### HuggingFace 미러 데이터셋 (덤프 대체 가능)
- `heegyu/namuwiki` — 원본 덤프 미러 (867,024개 문서, 2022/03/01 기준)
- `heegyu/namuwiki-extracted` — 마크업 제거 후 정제된 텍스트 버전 **(권장)**
- 컬럼: `title`, `text`, `contributors`, `namespace`
- HuggingFace `datasets` 라이브러리(Python) 또는 Parquet 직접 다운로드 가능

> 인덱싱 스크립트는 두 소스를 모두 지원해야 한다.
> - `--source dump` : 공식 덤프 JSON 파일 경로
> - `--source huggingface` : HuggingFace 데이터셋 직접 스트리밍

---

## 기술 스택

| 역할 | 기술 |
|------|------|
| 언어 | TypeScript (Node.js 20+) |
| MCP 서버 | `@modelcontextprotocol/sdk` |
| REST API | Express |
| 검색 엔진 | **Meilisearch** (기본값) |
| 검색 엔진 대안 | SQLite FTS5 (경량, 외부 서비스 없이 실행 가능) |
| 덤프 파싱 | `ijson` 호환 스트리밍 파서 (`stream-json`) |
| 나무위키 마크업 파서 | 자체 구현 또는 정규식 기반 간이 제거 |
| 컨테이너 | Docker + docker-compose |

---

## 프로젝트 구조

```
namuwiki-search-mcp/
├── .claude/
│   └── CLAUDE.md               # 이 파일
├── src/
│   ├── types/
│   │   └── index.ts            # 공용 TypeScript 타입
│   ├── search/
│   │   ├── engine.ts           # SearchEngine 인터페이스 (추상화)
│   │   ├── meilisearch.ts      # Meilisearch 구현체
│   │   └── sqlite.ts           # SQLite FTS5 구현체 (경량 대안)
│   ├── indexer/
│   │   ├── dump-parser.ts      # 나무위키 JSON 덤프 스트리밍 파서
│   │   ├── hf-loader.ts        # HuggingFace 데이터셋 로더
│   │   └── indexer.ts          # 검색 엔진에 문서 인덱싱
│   ├── api/
│   │   ├── server.ts           # Express 앱
│   │   └── routes/
│   │       └── search.ts       # /search, /article 라우트
│   └── mcp/
│       ├── server.ts           # MCP 서버 진입점 (stdio 트랜스포트)
│       └── tools.ts            # MCP 툴 정의
├── scripts/
│   └── index-data.ts           # 인덱싱 CLI 스크립트
├── data/                       # 덤프 파일 저장 위치 (gitignore)
├── docker-compose.yml          # Meilisearch 컨테이너
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

---

## MCP 툴 명세

### `search_namuwiki`
나무위키에서 키워드로 문서를 검색한다.

```typescript
// 입력
{
  query: string;       // 검색 키워드
  limit?: number;      // 결과 수 (기본값: 5, 최대: 20)
  namespace?: string;  // 네임스페이스 필터 (기본값: 일반 문서만)
}

// 출력
{
  results: Array<{
    title: string;
    snippet: string;   // 검색어 주변 텍스트 발췌 (최대 300자)
    score: number;     // 관련도 점수
  }>;
  total: number;
}
```

### `get_namuwiki_article`
나무위키 문서를 제목으로 가져온다.

```typescript
// 입력
{
  title: string;        // 정확한 문서 제목
  plain_text?: boolean; // true면 마크업 제거 후 반환 (기본값: true)
}

// 출력
{
  title: string;
  text: string;         // 본문 (plain_text=true면 마크업 제거)
  contributors: string[];
  found: boolean;
}
```

---

## REST API 명세

```
GET /search?q=<키워드>&limit=<수>&namespace=<네임스페이스>
GET /article/:title
GET /health
```

응답 형식은 MCP 툴 출력과 동일한 구조를 사용한다.

---

## 환경 변수 (.env)

```
# Meilisearch
MEILISEARCH_HOST=http://localhost:7700
MEILISEARCH_API_KEY=masterKey

# 검색 엔진 선택 (meilisearch | sqlite)
SEARCH_ENGINE=meilisearch

# SQLite (SEARCH_ENGINE=sqlite일 때)
SQLITE_DB_PATH=./data/namuwiki.db

# API 서버
API_PORT=3000

# MCP 서버 트랜스포트 (stdio | http)
MCP_TRANSPORT=stdio
MCP_HTTP_PORT=3001
```

---

## 코딩 규칙 (이 프로젝트 한정)

### 검색 엔진 추상화
- `SearchEngine` 인터페이스를 반드시 지켜라.
- 새 검색 엔진을 추가할 때 API 레이어를 수정하지 않아도 된다.

### 나무위키 마크업
- 마크업 완전 파싱은 하지 않는다. 검색 및 스니펫 생성에 필요한 수준의 정제만 한다.
- `[[링크]]`, `{{{색}}}`, `[include]` 등 주요 패턴만 정규식으로 제거한다.
- 원문 마크업도 `text_raw` 필드로 함께 저장한다.

### 스트리밍 파싱
- 덤프 JSON은 12GB 이상이므로 반드시 스트리밍으로 처리한다.
- `stream-json` 패키지의 `StreamArray`를 사용한다.
- 청크 단위로 Meilisearch에 배치 인덱싱한다 (기본 배치: 500개).

### MCP 서버
- 트랜스포트는 `stdio`를 기본으로 한다 (Claude Desktop, Claude Code와 직접 연동).
- HTTP 트랜스포트는 `MCP_TRANSPORT=http`로 선택적으로 활성화한다.
- 툴 입력 스키마는 Zod로 정의하고, MCP SDK의 `zodToJsonSchema`로 변환한다.

### 에러 처리
- 검색 엔진 연결 실패 시 503 응답 + 명확한 메시지.
- 문서 미발견 시 `found: false` 반환 (404 에러 대신).
- MCP 툴에서 에러 발생 시 `isError: true`로 MCP 규격에 맞게 반환.

---

## 실행 방법 (예정)

```powershell
# 1. Meilisearch 실행
docker-compose up -d

# 2. 의존성 설치
npm install

# 3. 덤프 인덱싱 (HuggingFace 소스)
npx tsx scripts/index-data.ts --source huggingface

# 4. REST API 서버 실행
npm run api

# 5. MCP 서버 실행 (stdio)
npm run mcp
```

---

## 라이선스 및 저작권

- 나무위키 데이터는 **CC BY-SA 2.0 KR** 라이선스다.
- 이 서비스도 동일 라이선스 조건을 준수해야 한다.
- 출처 표기 필수: 출처는 나무위키(https://namu.wiki)임을 명시.
- 상업적 이용 시 별도 검토 필요.
