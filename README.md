# namuwiki-search-mcp

나무위키 공개 데이터 덤프를 활용한 **검색 REST API**와 **MCP(Model Context Protocol) 서버**입니다.
나무위키 공식 검색 API가 없기 때문에, 공개 덤프를 검색 엔진에 색인하여 키워드/제목 검색을 제공하는 공익 오픈소스 프로젝트입니다.

> 데이터 출처: [나무위키](https://namu.wiki) — 라이선스 **CC BY-SA 2.0 KR**

---

## 아키텍처

검색 로직은 **REST API 한 곳에만** 존재합니다. MCP 서버는 그 REST API를 HTTP로 호출하는 얇은 클라이언트입니다 (로직 중복 없음).

```
┌───────────┐   HTTP GET /search        ┌──────────────┐
│ MCP 서버  │ ───────────────────────→  │  REST API     │
│ stdio/http│   HTTP GET /article/:t    │  (Express)    │
└───────────┘ ←─────────────────────── └──────┬───────┘
   얇은 클라이언트       JSON 응답               │ 직접 호출
                                                ↓
                                       ┌──────────────┐
                                       │ SearchEngine │  ← 추상화 인터페이스
                                       └──────┬───────┘
                              ┌───────────────┼───────────────┐
                              ↓               ↓               ↓
                        ┌──────────┐  ┌──────────────┐  ┌──────────┐
                        │ SQLite   │  │ Meilisearch  │  │ MySQL    │
                        │ FTS5     │  │              │  │ (RDS)    │
                        └──────────┘  └──────────────┘  └──────────┘
```

- **SQLite FTS5**: 외부 서비스 불필요, 단일 파일 DB. 로컬 테스트 + **운영(서버) 검색 기본값**(`SEARCH_ENGINE=sqlite`).
- **Meilisearch**: 한국어 검색 품질에 유리. Docker로 기동(선택).
- **MySQL (InnoDB FULLTEXT + ngram)**: 검색 엔진 구현체로도 선택 가능(`SEARCH_ENGINE=mysql`). 단 **운영 검색 기본은 SQLite**다.

> **운영 저장소 분리**: 검색 데이터(`documents`)는 **SQLite**(서버 볼륨, 덤프라 재색인 가능),
> API 키(`api_keys`)·사용 로그(`usage_logs`)는 **MySQL**(영속). 자세히는 [docs/DEPLOY.md](docs/DEPLOY.md).

MCP 트랜스포트는 로컬 연동 시 `stdio`, 원격 배포 시 `http`(Streamable HTTP)다.

---

## 빠른 시작 (로컬 테스트, Docker 불필요)

```powershell
# 1. 의존성 설치
npm install

# 2. 환경 변수 준비 (sqlite 엔진이 기본값)
Copy-Item .env.example .env

# 3. 엔드투엔드 스모크 테스트 (샘플 데이터 자동 생성 → 인덱싱 → API → MCP 경로 검증)
npm run test:local
```

`test:local`이 통과하면 인덱싱·검색·REST·MCP 클라이언트 경로가 모두 정상입니다.

### 수동으로 돌려보기

```powershell
# 1. 샘플 데이터 생성 (data/sample.json)
npm run gen-sample

# 2. 샘플 색인 (SQLite)
npm run index -- --source sample

# 3. REST API 서버 실행
npm run api
# 다른 터미널에서:
#   curl "http://localhost:3000/search?q=타입스크립트"
#   curl "http://localhost:3000/article/나무위키"
#   curl "http://localhost:3000/health"

# 4. MCP 서버 실행 (REST API가 떠 있는 상태에서)
npm run mcp
```

---

## 인덱싱

검색 엔진은 `.env`의 `SEARCH_ENGINE`(`sqlite` | `meilisearch` | `mysql`)에 따라 결정됩니다. 운영(서버)은 `sqlite`입니다.

```powershell
# 샘플 (로컬 테스트용)
npm run index -- --source sample

# 공식 덤프 JSON (12GB+, 스트리밍 파싱)
npm run index -- --source dump --file ./data/namuwiki.json

# HuggingFace 데이터셋 (parquet 직접 스트리밍, 권장)
#   heegyu/namuwiki-extracted의 parquet(약 2.2GB)을 HTTP Range로 부분 읽기 한다.
#   --limit으로 앞쪽 일부만 받으면 전체를 내려받지 않는다.
npm run index -- --source huggingface --limit 50000

# 전체(약 56.5만 건) — 디스크 5GB+, 수십 분 소요
npm run index -- --source huggingface

# datasets-server rows API 방식(소량/간편, 대량은 느림)
npm run index -- --source huggingface --method rows --limit 1000
```

> 참고: 이 데이터셋은 `contributors`가 콤마 구분 문자열, `namespace`가 빈 값이라
> 로더에서 각각 배열 분리 / `"문서"` 정규화 처리합니다.

---

## Meilisearch로 전환

```powershell
# 1. Meilisearch 컨테이너 기동
docker-compose up -d

# 2. .env에서 엔진 변경
#   SEARCH_ENGINE=meilisearch

# 3. 색인 후 API/MCP 실행
npm run index -- --source sample
npm run api
```

---

## API 명세

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/search?q=<키워드>&limit=<수>&namespace=<NS>` | 키워드 검색 |
| GET | `/article/:title?plain_text=<true\|false>` | 제목으로 문서 조회 |
| GET | `/health` | 헬스체크 |

- 문서 미발견 시 404가 아니라 `{ found: false }`를 반환합니다.
- 검색 엔진 연결 실패 시 `503`을 반환합니다.

### MCP 툴

| 툴 | 설명 | 호출하는 REST |
|----|------|----------------|
| `search_namuwiki` | 키워드 검색 | `GET /search` |
| `get_namuwiki_article` | 제목으로 문서 조회 | `GET /article/:title` |

---

## 환경 변수

`.env.example` 참고. 주요 값:

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `SEARCH_ENGINE` | `sqlite` | 검색 엔진 (`sqlite` \| `meilisearch` \| `mysql`). **운영(서버)은 `sqlite`** |
| `SQLITE_DB_PATH` | `./data/namuwiki.db` | SQLite DB 경로 (서버는 볼륨 `/data/namuwiki.db`) |
| `MEILISEARCH_HOST` | `http://localhost:7700` | Meilisearch 호스트 |
| `MYSQL_HOST` / `MYSQL_PORT` | `localhost` / `3306` | MySQL(RDS) 접속 — **API 키·사용 로그용**(검색 아님) |
| `MYSQL_USER` / `MYSQL_PASSWORD` | `root` / `` | MySQL 자격증명 |
| `MYSQL_DATABASE` | `namuwiki` | MySQL 데이터베이스명 |
| `API_PORT` | `3000` | REST API 포트 |
| `API_BASE_URL` | `http://localhost:3000` | MCP가 호출할 REST API 주소 |
| `MCP_TRANSPORT` | `stdio` | MCP 트랜스포트 (`stdio` \| `http`). 원격 배포는 `http` |
| `MCP_HTTP_PORT` | `3001` | `http` 트랜스포트 포트 |

---

## 프로젝트 구조

```
src/
├── types/index.ts          # 공용 타입
├── config.ts               # 환경 변수 로딩 + 엔진 팩토리
├── search/
│   ├── engine.ts           # SearchEngine 인터페이스
│   ├── sqlite.ts           # SQLite FTS5 구현체
│   ├── meilisearch.ts      # Meilisearch 구현체
│   └── mysql.ts            # MySQL(RDS, FULLTEXT) 구현체 — 운영 기본
├── indexer/
│   ├── markup.ts           # 나무위키 마크업 정제 + 스니펫
│   ├── dump-parser.ts      # 덤프 JSON 스트리밍 파서
│   ├── hf-loader.ts        # HuggingFace 로더
│   └── indexer.ts          # 배치 인덱싱 오케스트레이터
├── api/
│   ├── server.ts           # Express 앱 (검색 로직의 단일 소스)
│   └── routes/search.ts    # /search, /article 라우트
└── mcp/
    ├── server.ts           # MCP 서버 (stdio)
    └── tools.ts            # MCP 툴 정의 + REST 클라이언트
scripts/
├── gen-sample.ts           # 샘플 데이터 생성
├── index-data.ts           # 인덱싱 CLI
└── test-local.ts           # 엔드투엔드 스모크 테스트
```

---

## 라이선스

데이터는 나무위키의 **CC BY-SA 2.0 KR**를 따릅니다. 본 프로젝트도 동일 조건을 준수하며, 출처는 나무위키(https://namu.wiki)임을 명시합니다.
