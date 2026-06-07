# 배포 가이드

REST API는 **Vercel**, MCP 서버는 **AWS Lightsail**(기존 tan-kim 서버), 검색 데이터는 **AWS RDS(MySQL)** 에 둔다.
외부 노출은 기존 도메인 아래 **경로 기반**으로 통합한다.

## 아키텍처

```
┌────────────────────────┐                  ┌──────────────────────────────────────┐
│  Vercel (무료)         │                  │  AWS Lightsail (기존 tan-kim 서버)    │
│  REST API              │                  │  ┌──────────────────────────────────┐ │
│  api.tan-kim.com       │                  │  │  Caddy (기존, 80/443)             │ │
│   /namuwiki            │                  │  │   /namuwiki → namu-mcp:3001        │ │
└───────────┬────────────┘                  │  └───────────┬──────────────────────┘ │
            │                                │              │ caddy-shared(edge)     │
            │                  Claude ──────→│  ┌───────────┴──────────────────────┐ │
            │                  (mcp.tan-kim  │  │ namu-mcp:3001 ─→ namu-api:3000     │ │
            │                   .com/namuwiki)│  └───────────────────────┬──────────┘ │
            │                                └──────────────────────────┼────────────┘
            │                                                           │
            └──────────────────────────────┬────────────────────────────┘
                                            ↓ MySQL 연결
                                  ┌────────────────────┐
                                  │  AWS RDS (MySQL)   │
                                  │  InnoDB FULLTEXT   │
                                  │  + ngram 파서      │
                                  └────────────────────┘
```

- **검색 백엔드 = RDS(MySQL)**: Vercel REST API와 Lightsail api가 **같은 RDS**를 본다.
- **Vercel REST API**: RDS에 직접 연결해 검색 수행.
- **MCP 서버**: Lightsail 내부 `namu-api:3000` 호출 → api가 RDS 조회.
- **포트 충돌 없음**: compose에 호스트 포트 바인딩 없음. 외부 노출은 기존 Caddy(/namuwiki)만.

> ⚠️ **RDS 보안 그룹**: api 컨테이너(Lightsail 고정 IP)와 Vercel(동적 IP)이 RDS 3306에 접근해야 한다.
> - Lightsail: RDS SG에 Lightsail 공인 IP 허용 (권장)
> - Vercel: 함수 IP가 고정되지 않음 → SG를 좁히기 어렵다. 강한 자격증명 + 가능하면 SSL 강제를 둘 것.
>   더 엄격히 하려면 Vercel이 RDS에 직접 붙는 대신 Lightsail api를 경유하도록 바꾸는 방안도 있다.

---

## 1. Lightsail 배포 (MCP + 내부 api)

### 1-1. 초기 서버 설정 (최초 1회)

```bash
ssh <AWS_USER>@<AWS_HOST>
git clone https://github.com/<owner>/namuwiki-search-mcp.git ~/namuwiki-search-mcp

# compose 환경변수 배치 (infra/server-secrets.example 참고)
nano ~/namuwiki-search-mcp/infra/.env
```

`infra/.env` (compose가 읽는다 — RDS 자격증명):

```env
MYSQL_HOST=your-namuwiki.xxxx.ap-northeast-2.rds.amazonaws.com
MYSQL_PORT=3306
MYSQL_USER=admin
MYSQL_PASSWORD=<RDS 비밀번호>
MYSQL_DATABASE=namuwiki
```

### 1-2. tan-kim 분리 / Caddy 연동

namuwiki는 `name: namuwiki`로 프로젝트를 분리하고, 중립 공유망 `edge`로만 tan-kim Caddy와 연결한다.

> tan-kim 레포에도 대응 변경 적용됨: Caddyfile에 `mcp.tan-kim.com {/namuwiki → namu-mcp}` 블록,
> caddy 서비스에 `edge` 네트워크 + `NAMU_MCP_BEARER_TOKEN`, 배포 스크립트에 `edge` 멱등 생성.

서버에서:

```bash
# 중립 네트워크 생성 (최초 1회, 배포 스크립트도 멱등 생성함)
docker network create edge 2>/dev/null || true

# tan-kim Caddy에 토큰 주입 (~/tan-kim/infra/.env)
echo 'NAMU_MCP_BEARER_TOKEN=<강력한 랜덤 토큰>' >> ~/tan-kim/infra/.env

# tan-kim 재배포 또는 Caddy reload
cd ~/tan-kim && docker compose -f infra/docker-compose.yml up -d
```

### 1-3. 기동

```bash
cd ~/namuwiki-search-mcp
docker compose -f infra/docker-compose.yml build
docker compose -f infra/docker-compose.yml up -d
```

### 1-4. 인덱싱

RDS에 데이터를 적재한다. (api 컨테이너 또는 별도 환경에서 실행 가능)

```bash
docker compose -f infra/docker-compose.yml exec api \
  npm run index -- --source huggingface
```

> MySQL 엔진은 대량 적재가 끝난 뒤 FULLTEXT(ngram) 인덱스를 한 번에 생성한다.

---

## 2. GitHub Actions 자동 배포

`main` push 시 `deploy-aws.yml`이 typecheck → rsync → `docker compose build && up`을 수행.

### Secrets

| Secret | 값 |
|--------|----|
| `AWS_HOST` | Lightsail 공인 IP |
| `AWS_USER` | SSH 유저명 (예: `ubuntu`) |
| `AWS_SSH_KEY` | SSH 개인키 전체 내용 |

---

## 3. Vercel 배포 (REST API)

### 3-1. 프로젝트 설정
- Root Directory: `./`, Framework Preset: `Other`, Node.js 20.x
- (선택) Functions Region: `Seoul (icn1)` — RDS와 가깝게

### 3-2. 환경변수 (Production)

| 변수 | 값 |
|------|----|
| `SEARCH_ENGINE` | `mysql` |
| `MYSQL_HOST` | RDS 엔드포인트 |
| `MYSQL_PORT` | `3306` |
| `MYSQL_USER` | RDS 유저 |
| `MYSQL_PASSWORD` | RDS 비밀번호 |
| `MYSQL_DATABASE` | `namuwiki` |

> 기존 `MEILISEARCH_*` 변수는 무시되므로 남겨둬도 무방하나, 혼동 방지를 위해 삭제 권장.
> 변경 후 **재배포** 해야 반영된다.

### 3-3. 도메인 (api.tan-kim.com/namuwiki)

`api.tan-kim.com`은 tan-kim 백엔드 소유다. tan-kim 백엔드 `apps/backend/vercel.json`에
namuwiki 프록시 rewrite를 catch-all보다 먼저 추가한다:

```json
{
  "rewrites": [
    { "source": "/namuwiki/:path*", "destination": "https://namuwiki-search-mcp.vercel.app/:path*" },
    { "source": "/(.*)", "destination": "/api/index" }
  ]
}
```

---

## 엔드포인트 요약

| 용도 | URL | 인증 |
|------|-----|------|
| REST API | `https://api.tan-kim.com/namuwiki/search?q=...` | 없음 (필요 시 추가) |
| REST API (직접) | `https://namuwiki-search-mcp.vercel.app/search?q=...` | 없음 |
| MCP (Claude) | `https://mcp.tan-kim.com/namuwiki` | Bearer 토큰 |

---

## 4. Claude Code에 MCP 등록

```json
{
  "mcpServers": {
    "namuwiki": {
      "type": "http",
      "url": "https://mcp.tan-kim.com/namuwiki",
      "headers": { "Authorization": "Bearer <NAMU_MCP_BEARER_TOKEN>" }
    }
  }
}
```
