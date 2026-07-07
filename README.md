# namuwiki-search-mcp

나무위키 공개 데이터 덤프를 활용한 **검색 REST API**와 **MCP(Model Context Protocol) 서버**입니다.
나무위키에는 공식 검색 API가 없어서, 공개 덤프를 검색 엔진에 색인해 키워드/제목 검색을 제공하는 **공익 오픈소스 프로젝트**입니다.

- **그냥 검색만 쓰고 싶다** → [1. 호스팅된 공개 서비스 사용하기](#1-호스팅된-공개-서비스-사용하기) (설치 불필요)
- **Claude에서 나무위키를 검색하게 하고 싶다** → [2. Claude에 MCP 연결하기](#2-claude에-mcp-연결하기)
- **내 서버/로컬에서 직접 돌리고 싶다** → [3. 직접 실행 / 셀프호스트](#3-직접-실행--셀프호스트)

> 데이터 출처: [나무위키](https://namu.wiki) — 라이선스 **CC BY-SA 2.0 KR**

---

## 한눈에 보기

대부분의 사용자는 아무것도 설치할 필요가 없습니다. 공개 엔드포인트에서 **키 1개를 발급**받아 REST API와 MCP를 모두 사용합니다.

```
┌──────────────┐  ① POST /namuwiki/keys (인증 불필요)
│  나 / 내 앱   │ ───────────────────────────────────→  키 발급 (nw_xxxx)
└──────┬───────┘
       │ ② Authorization: Bearer nw_xxxx
       │
       ├─────────────→  https://api.tan-kim.com/namuwiki   (REST 검색)
       │
       └─────────────→  https://mcp.tan-kim.com/namuwiki   (Claude MCP)
```

| 용도 | 엔드포인트 | 인증 |
|------|-----------|------|
| 키 발급(셀프) | `POST https://api.tan-kim.com/namuwiki/keys` | 불필요 |
| 키워드 검색 | `GET https://api.tan-kim.com/namuwiki/search?q=...` | `Bearer <키>` |
| 문서 조회 | `GET https://api.tan-kim.com/namuwiki/article/<제목>` | `Bearer <키>` |
| 헬스체크 | `GET https://api.tan-kim.com/namuwiki/health` | 불필요 |
| MCP (Claude) | `https://mcp.tan-kim.com/namuwiki` | `Bearer <키>` |

> ⚠️ `api.tan-kim.com` / `mcp.tan-kim.com`은 본 프로젝트의 레퍼런스 운영 도메인입니다. 직접 배포한 경우 자신의 도메인으로 바꿔 읽으세요.

---

## 1. 호스팅된 공개 서비스 사용하기

### 1-1. API 키 발급 (셀프 발급)

인증 없이 누구나 키를 발급받을 수 있습니다. 발급된 키 1개로 REST와 MCP를 모두 사용합니다.

```bash
curl -X POST https://api.tan-kim.com/namuwiki/keys \
  -H "Content-Type: application/json" \
  -d '{"name":"내-블로그봇"}'
```

응답 (원본 키는 **이때 한 번만** 표시됩니다 — 서버는 해시만 저장하므로 분실 시 재발급):

```json
{
  "id": 12,
  "name": "내-블로그봇",
  "rate_per_min": 30,
  "api_key": "nw_a1B2c3D4...",
  "note": "api_key는 지금만 표시됩니다. 안전한 곳에 보관하세요(서버는 해시만 저장)."
}
```

- `name`은 생략 가능하며 키 용도를 식별하는 라벨입니다.
- 셀프 발급 키의 기본 한도는 **분당 30요청**입니다. 더 높은 한도가 필요하면 운영자에게 문의하세요(관리자 발급으로 상향).
- 남용 방지를 위해 **IP당 발급 횟수에 시간당 제한**이 있습니다. 초과 시 발급이 일시적으로 막힙니다.

### 1-2. 키워드 검색 — `GET /search`

```bash
curl "https://api.tan-kim.com/namuwiki/search?q=리눅스&limit=3" \
  -H "Authorization: Bearer nw_a1B2c3D4..."
```

| 쿼리 파라미터 | 필수 | 기본값 | 설명 |
|--------------|------|--------|------|
| `q` | ✅ | — | 검색 키워드 |
| `limit` | ❌ | 5 | 결과 수 (최대 20) |
| `namespace` | ❌ | 일반 문서 | 네임스페이스 필터 |

응답:

```json
{
  "results": [
    { "title": "리눅스", "snippet": "...검색어 주변 발췌(최대 300자)...", "score": 12.4 }
  ],
  "total": 1
}
```

### 1-3. 문서 조회 — `GET /article/:title`

```bash
curl "https://api.tan-kim.com/namuwiki/article/리눅스" \
  -H "Authorization: Bearer nw_a1B2c3D4..."

# 마크업 원문 그대로 받기
curl "https://api.tan-kim.com/namuwiki/article/리눅스?plain_text=false" \
  -H "Authorization: Bearer nw_a1B2c3D4..."
```

| 쿼리 파라미터 | 기본값 | 설명 |
|--------------|--------|------|
| `plain_text` | `true` | `true`면 나무위키 마크업 제거, `false`면 원문 마크업 |

응답 (문서가 없으면 **404가 아니라** `found: false`):

```json
{ "title": "리눅스", "text": "...", "contributors": ["..."], "found": true, "source": "dump" }
```

> `source` 필드는 **크롤 폴백**(`CRAWL_FALLBACK=true`)이 켜져 있을 때만 채워집니다.
> `"dump"`는 인덱스에서 찾은 결과, `"crawled"`는 인덱스에 없어 나무위키에서 실시간으로 가져온 결과입니다. 자세한 동작은 [3-6. 크롤 폴백](#3-6-크롤-폴백-인덱스에-없는-문서-보완)을 보세요.

### 1-4. 다른 언어에서 호출하기

**JavaScript / TypeScript**

```ts
const KEY = "nw_a1B2c3D4...";
const res = await fetch(
  "https://api.tan-kim.com/namuwiki/search?q=" + encodeURIComponent("타입스크립트"),
  { headers: { Authorization: `Bearer ${KEY}` } },
);
const data = await res.json();
console.log(data.results);
```

**Python**

```python
import requests

KEY = "nw_a1B2c3D4..."
res = requests.get(
    "https://api.tan-kim.com/namuwiki/search",
    params={"q": "파이썬", "limit": 5},
    headers={"Authorization": f"Bearer {KEY}"},
)
print(res.json()["results"])
```

### 1-5. 응답 상태 코드

| 코드 | 의미 | 대처 |
|------|------|------|
| `200` | 정상 | — |
| `400` | `q` 누락 | 검색어를 넣으세요 |
| `401` | 키 없음/무효 | `Authorization: Bearer <키>` 확인, 폐기됐으면 재발급 |
| `429` | 분당 한도 초과 | 응답의 `RateLimit-*` 헤더를 보고 잠시 후 재시도 |
| `503` | 서버 혼잡/타임아웃/검색엔진 일시 장애 | `Retry-After` 만큼 대기 후 재시도 |

> 요청량 한도는 응답 헤더(`RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, 표준 draft-7)로 확인할 수 있습니다.

---

## 2. Claude에 MCP 연결하기

발급받은 `nw_...` 키를 그대로 MCP 설정에 넣으면, Claude가 나무위키를 검색/조회할 수 있습니다.

### Claude Code (`.mcp.json` 또는 사용자 설정)

```json
{
  "mcpServers": {
    "namuwiki": {
      "type": "http",
      "url": "https://mcp.tan-kim.com/namuwiki",
      "headers": { "Authorization": "Bearer nw_a1B2c3D4..." }
    }
  }
}
```

### Claude Desktop

`claude_desktop_config.json`에 위와 동일한 `mcpServers` 블록을 추가하고 앱을 재시작합니다.

### 제공되는 MCP 툴

| 툴 | 설명 | 입력 |
|----|------|------|
| `search_namuwiki` | 키워드로 문서 검색 | `query`, `limit?`(≤20), `namespace?` |
| `get_namuwiki_article` | 제목으로 문서 조회 | `title`, `plain_text?` |

연결되면 Claude에게 *"나무위키에서 '리눅스' 검색해줘"* 처럼 자연어로 요청할 수 있습니다.

> MCP 서버는 자체 인증을 하지 않습니다. 설정에 넣은 `Authorization` 토큰을 내부 REST API로 그대로 전달해 인증합니다. 즉 **REST 키와 MCP 키는 동일**합니다.

---

## 3. 직접 실행 / 셀프호스트

외부 서비스 없이 로컬에서 바로 돌려볼 수 있습니다(SQLite 기본). 운영 배포는 [docs/DEPLOY.md](docs/DEPLOY.md)를 참고하세요.

### 3-1. 빠른 시작 (Docker 불필요)

```powershell
# 1. 의존성 설치
npm install

# 2. 환경 변수 준비 (sqlite 엔진이 기본값, 키 인증 없음)
Copy-Item .env.example .env

# 3. 엔드투엔드 스모크 테스트 (샘플 생성 → 색인 → API → MCP 경로 검증)
npm run test:local
```

`test:local`이 통과하면 색인·검색·REST·MCP 클라이언트 경로가 모두 정상입니다.

### 3-2. 수동으로 돌려보기

```powershell
# 1. 샘플 데이터 생성 (data/sample.json)
npm run gen-sample

# 2. 샘플 색인 (SQLite)
npm run index -- --source sample

# 3. REST API 서버 실행 (인증 없음 — 로컬 기본)
npm run api
# 다른 터미널에서:
#   curl "http://localhost:3000/search?q=타입스크립트"
#   curl "http://localhost:3000/article/나무위키"
#   curl "http://localhost:3000/health"

# 4. MCP 서버 실행 (REST API가 떠 있는 상태에서, stdio 트랜스포트)
npm run mcp
```

> 로컬(`SEARCH_ENGINE=sqlite`)에서는 기본적으로 **API 키 인증이 꺼져** 있어 헤더 없이 바로 호출됩니다. 키 흐름까지 테스트하려면 [3-5. 키 인증 켜고 테스트](#3-5-키-인증-켜고-테스트)를 보세요.

### 3-3. 실제 데이터 색인

검색 엔진은 `.env`의 `SEARCH_ENGINE`(`sqlite` | `meilisearch` | `mysql`)로 결정됩니다. 운영 기본값은 `sqlite`입니다.

```powershell
# 공식 덤프 JSON (12GB+, 스트리밍 파싱)
npm run index -- --source dump --file ./data/namuwiki.json

# HuggingFace 데이터셋 (parquet 직접 스트리밍, 권장)
#   --limit으로 앞쪽 일부만 받으면 전체를 내려받지 않는다.
npm run index -- --source huggingface --limit 50000

# 전체(약 56.5만 건) — 디스크 5GB+, 수십 분 소요
npm run index -- --source huggingface
```

> 데이터 소스 `heegyu/namuwiki-extracted`는 `contributors`가 콤마 구분 문자열, `namespace`가 빈 값이라 로더에서 각각 배열 분리 / `"문서"` 정규화 처리합니다.

### 3-4. Meilisearch로 전환 (선택)

```powershell
docker-compose up -d                 # 1. Meilisearch 컨테이너 기동
# 2. .env에서 SEARCH_ENGINE=meilisearch 로 변경
npm run index -- --source sample     # 3. 색인 후 실행
npm run api
```

### 3-5. 키 인증 켜고 테스트

운영처럼 API 키를 강제하려면 `.env`에서:

```env
REQUIRE_API_KEY=true
ADMIN_API_TOKEN=로컬-테스트용-임의-토큰
# 키/사용로그 영속 저장에 MySQL이 필요 (검색 데이터는 여전히 SQLite)
MYSQL_HOST=localhost
MYSQL_USER=root
MYSQL_PASSWORD=...
MYSQL_DATABASE=namuwiki
```

키 발급 방법은 두 가지입니다.

```bash
# (A) 셀프 발급 — 인증 불필요, 낮은 기본 한도
curl -X POST http://localhost:3000/keys -H "Content-Type: application/json" -d '{"name":"test"}'

# (B) 관리자 발급 — ADMIN_API_TOKEN 필요, 한도 지정 가능
curl -X POST http://localhost:3000/admin/keys \
  -H "Authorization: Bearer 로컬-테스트용-임의-토큰" \
  -H "Content-Type: application/json" \
  -d '{"name":"bot","rate_per_min":120}'
```

자세한 키 정책은 [docs/API-KEYS.md](docs/API-KEYS.md)를 참고하세요.

### 3-6. 크롤 폴백 (인덱스에 없는 문서 보완)

덤프는 특정 시점의 스냅샷이라 이후 생성된 문서나 색인되지 않은 문서는 `found: false`가 됩니다.
**크롤 폴백**을 켜면, 인덱스에 없는 문서를 요청받았을 때 나무위키에서 실시간으로 가져와 반환하고 **인덱스에 upsert**해 다음 조회부터는 즉시 응답합니다. `GET /article/:title`에만 적용됩니다(검색 `/search`에는 미적용).

```env
CRAWL_FALLBACK=true                        # 폴백 켜기 (기본 false)
NAMU_CRAWL_URL=https://namu.wiki/w/{title} # {title}이 URL 인코딩된 제목으로 치환
CRAWL_TIMEOUT_MS=5000                       # 요청 타임아웃
CRAWL_RETRIES=2                             # 실패 시 재시도 횟수
```

동작:

```
GET /article/제목
  └─ 인덱스에 있음     → 반환 (source: "dump")
  └─ 인덱스에 없음
       └─ 크롤 성공    → 인덱스 upsert 후 반환 (source: "crawled")
       └─ 크롤 실패/미발견/차단 → 기존 found: false 유지
```

> ⚠️ **기본은 "인덱스에만" 추가합니다.** 인덱스는 재생성 가능한 검색 캐시 성격이라 안전하지만,
> 크롤 결과를 **영속 파일에 누적**하면 나무위키 데이터베이스의 "상당한 부분"을 스크래핑해 재구축하는 셈이 되어 **데이터베이스제작자의 권리** 리스크가 생깁니다.
> 그래서 파일 누적은 명시적 opt-in(`CRAWL_APPEND_DUMP=true`)일 때만 동작하며, 기본값은 꺼져 있습니다.
> robots.txt는 `/w/`(문서 페이지) 크롤을 허용하고, 콘텐츠는 CC BY-SA 2.0 KR로 출처표시 하에 재배포 가능합니다.

```env
# (opt-in) 크롤 결과를 JSONL 사이드카에 누적 — 기본 false
CRAWL_APPEND_DUMP=true
CRAWL_DUMP_PATH=./data/crawled.jsonl
```

누적한 사이드카는 재인덱싱으로 영구 반영할 수 있습니다(id 기준 upsert라 중복 안전):

```powershell
npm run index -- --source crawled --file ./data/crawled.jsonl
```

---

## 아키텍처

검색 로직은 **REST API 한 곳에만** 존재합니다. MCP 서버는 그 REST API를 HTTP로 호출하는 얇은 클라이언트입니다(로직 중복 없음).

```
┌───────────┐   HTTP GET /search        ┌──────────────┐
│ MCP 서버  │ ───────────────────────→  │  REST API     │
│ stdio/http│   HTTP GET /article/:t    │  (Express)    │
└───────────┘ ←─────────────────────── └──────┬───────┘
   얇은 클라이언트       JSON 응답               │ 직접 호출
   (키 패스스루)                                ↓
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

- **SQLite FTS5**: 외부 서비스 불필요, 단일 파일 DB. 로컬 테스트 + **운영(서버) 검색 기본값**.
- **Meilisearch**: 한국어 검색 품질에 유리. Docker로 기동(선택).
- **MySQL (InnoDB FULLTEXT + ngram)**: 검색 엔진 구현체로도 선택 가능. 단 **운영 검색 기본은 SQLite**.

> **운영 저장소 분리**: 검색 데이터(`documents`)는 **SQLite**(서버 볼륨, 덤프라 재색인 가능),
> API 키(`api_keys`)·사용 로그(`usage_logs`)는 **MySQL**(영속). 자세히는 [docs/DEPLOY.md](docs/DEPLOY.md).

MCP 트랜스포트는 로컬 연동 시 `stdio`, 원격 배포 시 `http`(Streamable HTTP)입니다.

---

## 환경 변수

`.env.example` 참고. 주요 값:

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `SEARCH_ENGINE` | `sqlite` | 검색 엔진 (`sqlite` \| `meilisearch` \| `mysql`). **운영은 `sqlite`** |
| `SQLITE_DB_PATH` | `./data/namuwiki.db` | SQLite DB 경로 (서버는 볼륨 `/data/namuwiki.db`) |
| `MEILISEARCH_HOST` | `http://localhost:7700` | Meilisearch 호스트 |
| `MYSQL_HOST` / `MYSQL_PORT` | `localhost` / `3306` | MySQL(RDS) — **API 키·사용 로그용**(검색 아님) |
| `MYSQL_USER` / `MYSQL_PASSWORD` | `root` / `` | MySQL 자격증명 |
| `MYSQL_DATABASE` | `namuwiki` | MySQL 데이터베이스명 |
| `API_PORT` | `3000` | REST API 포트 |
| `API_BASE_URL` | `http://localhost:3000` | MCP가 호출할 REST API 주소 |
| `MCP_TRANSPORT` | `stdio` | MCP 트랜스포트 (`stdio` \| `http`). 원격 배포는 `http` |
| `MCP_HTTP_PORT` | `3001` | `http` 트랜스포트 포트 |
| `REQUIRE_API_KEY` | (mysql이면 `true`) | 외부 요청에 API 키 강제 여부 |
| `ADMIN_API_TOKEN` | `` | `/admin/keys`(키 발급/폐기) 보호 토큰 |
| `CRAWL_FALLBACK` | `false` | 인덱스에 없는 문서를 실시간 크롤로 보완 (문서 조회 한정) |
| `NAMU_CRAWL_URL` | `https://namu.wiki/w/{title}` | 크롤 대상 URL 템플릿 (`{title}` 치환) |
| `CRAWL_APPEND_DUMP` | `false` | 크롤 결과를 JSONL 사이드카에 누적 (법적 리스크로 기본 off) |

부하 보호 관련(`CACHE_*`, `MAX_CONCURRENT`, `REQUEST_TIMEOUT_MS`, `SELF_ISSUE*`), 크롤 세부(`CRAWL_TIMEOUT_MS`, `CRAWL_RETRIES`, `CRAWL_DUMP_PATH`)는 `.env.example` 참고.

---

## 프로젝트 구조

```
src/
├── types/index.ts          # 공용 타입
├── config.ts               # 환경 변수 로딩 + 엔진/저장소 팩토리
├── search/
│   ├── engine.ts           # SearchEngine 인터페이스
│   ├── sqlite.ts           # SQLite FTS5 구현체 — 운영 기본
│   ├── meilisearch.ts      # Meilisearch 구현체
│   ├── mysql.ts            # MySQL(RDS, FULLTEXT) 구현체
│   └── fallback.ts         # 크롤 폴백 데코레이터 (미발견 시 실시간 크롤)
├── crawler/
│   ├── namu.ts             # 나무위키 단건 크롤러 (fetch + 재시도)
│   └── dump-append.ts      # 크롤 결과 JSONL 사이드카 append (opt-in)
├── apikeys/                # API 키 저장소(MySQL) + 검증/캐시
├── usagelog/               # 사용 로그 저장소(MySQL)
├── indexer/
│   ├── markup.ts           # 나무위키 마크업 정제 + 스니펫
│   ├── dump-parser.ts      # 덤프 JSON 스트리밍 파서
│   ├── jsonl-parser.ts     # JSONL(크롤 사이드카) 파서
│   ├── hf-loader.ts        # HuggingFace 로더
│   └── indexer.ts          # 배치 인덱싱 오케스트레이터
├── api/
│   ├── server.ts           # Express 앱 (검색 로직의 단일 소스 + 키 인증/부하 보호)
│   ├── cache.ts            # 응답 캐시
│   └── routes/search.ts    # /search, /article 라우트
└── mcp/
    ├── server.ts           # MCP 서버 (stdio/http)
    └── tools.ts            # MCP 툴 정의 + REST 클라이언트
scripts/
├── gen-sample.ts           # 샘플 데이터 생성
├── index-data.ts           # 인덱싱 CLI
└── test-local.ts           # 엔드투엔드 스모크 테스트
docs/
├── DEPLOY.md               # 배포 가이드 (AWS Lightsail + Caddy)
└── API-KEYS.md             # API 키 발급/운영 정책
```

---

## 기여 / 문서

- 배포 방법: [docs/DEPLOY.md](docs/DEPLOY.md)
- API 키 정책: [docs/API-KEYS.md](docs/API-KEYS.md)
- 프로젝트 지침: `.claude/CLAUDE.md`

이슈와 PR을 환영합니다. 검색 엔진을 추가할 때는 `SearchEngine` 인터페이스만 구현하면 API/MCP 레이어를 수정할 필요가 없습니다.

---

## 라이선스

데이터는 나무위키의 **CC BY-SA 2.0 KR**를 따릅니다. 본 프로젝트도 동일 조건을 준수하며, 출처는 나무위키(https://namu.wiki)임을 명시합니다.
