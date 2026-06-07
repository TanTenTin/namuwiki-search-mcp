# 배포 가이드

REST API는 **Vercel**, MCP 서버 + 내부 api는 **AWS Lightsail**(기존 tan-kim 서버), 검색 데이터는 **AWS RDS(MySQL)** 에 둔다.
**Vercel은 RDS에 직접 붙지 않고 Lightsail 내부 api를 경유**한다 → DB 자격증명이 Vercel에 없고, RDS는 Lightsail 고정 IP만 허용하면 된다.

## 아키텍처

```
┌────────────────────────┐                  ┌──────────────────────────────────────┐
│  Vercel (무료)         │                  │  AWS Lightsail (기존 tan-kim 서버)    │
│  REST API              │                  │  ┌──────────────────────────────────┐ │
│  (RemoteSearchEngine,  │                  │  │  Caddy (기존, 80/443)             │ │
│   DB 자격증명 없음)    │                  │  │   /namuwiki     → namu-mcp:3001    │ │
│  SEARCH_ENGINE=remote  │ ──HTTPS+Bearer→  │  │   /namuwiki-api → namu-api:3000    │ │
└────────────────────────┘ (/namuwiki-api)  │  └──────┬───────────────┬───────────┘ │
                                            │  edge망 │        namu-internal망       │
   Claude ──MCP HTTP+Bearer───────────────→ │  ┌──────┴──────┐ ┌──────┴───────────┐ │
   (/namuwiki)                              │  │ namu-mcp     │→│ namu-api          │ │
                                            │  └─────────────┘ └────────┬──────────┘ │
                                            └───────────────────────────┼────────────┘
                                                                        │ MySQL
                                                                        ↓
                                                              ┌────────────────────┐
                                                              │  AWS RDS (MySQL)   │
                                                              │  Lightsail IP만 허용│
                                                              └────────────────────┘
```

- **Vercel = 얇은 프록시**: 검색 요청을 `mcp.tan-kim.com/namuwiki-api`(Lightsail api)로 위임. DB에 직접 접근하지 않음.
- **namu-api만 RDS 연결**: RDS 보안 그룹은 Lightsail 고정 IP만 3306 허용하면 됨 (Vercel 동적 IP 문제 해소).
- **MCP 서버**: 내부 `namu-api:3000` 호출 (Vercel과 같은 api를 공유).
- **포트 충돌 없음**: 호스트 포트 바인딩 없음. 외부 노출은 기존 Caddy 경로만.

---

## 1. Lightsail 배포 (MCP + 내부 api)

### 1-1. 초기 서버 설정 (최초 1회)

```bash
ssh <AWS_USER>@<AWS_HOST>
git clone https://github.com/<owner>/namuwiki-search-mcp.git ~/namuwiki-search-mcp
nano ~/namuwiki-search-mcp/infra/.env   # infra/server-secrets.example 참고
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

namuwiki는 `name: namuwiki`로 분리하고, 중립 공유망 `edge`로 tan-kim Caddy와 연결한다.
tan-kim Caddy는 두 경로를 추가로 노출한다:

- `/namuwiki`     → namu-mcp:3001  (Claude, `NAMU_MCP_BEARER_TOKEN` 보호)
- `/namuwiki-api` → namu-api:3000  (Vercel, `NAMU_API_TOKEN` 보호)

서버에서:

```bash
docker network create edge 2>/dev/null || true

# tan-kim Caddy에 두 토큰 주입 (~/tan-kim/infra/.env)
echo 'NAMU_MCP_BEARER_TOKEN=<랜덤 토큰1>' >> ~/tan-kim/infra/.env
echo 'NAMU_API_TOKEN=<랜덤 토큰2>'        >> ~/tan-kim/infra/.env

cd ~/tan-kim && docker compose -f infra/docker-compose.yml up -d   # Caddy 반영
```

### 1-3. 기동

```bash
cd ~/namuwiki-search-mcp
docker compose -f infra/docker-compose.yml build
docker compose -f infra/docker-compose.yml up -d --remove-orphans
```

### 1-4. 인덱싱 (RDS)

```bash
docker compose -f infra/docker-compose.yml exec api \
  npm run index -- --source huggingface
```

---

## 2. GitHub Actions 자동 배포

`main` push 시 `deploy-aws.yml`: typecheck → rsync → `docker compose build && up`.

| Secret | 값 |
|--------|----|
| `AWS_HOST` | Lightsail 공인 IP |
| `AWS_USER` | SSH 유저명 |
| `AWS_SSH_KEY` | SSH 개인키 전체 |

---

## 3. Vercel 배포 (REST API = 프록시)

### 3-1. 프로젝트 설정
- Root Directory `./`, Framework Preset `Other`, Node 20.x, (선택) Region `Seoul (icn1)`

### 3-2. 환경변수 (Production)

| 변수 | 값 |
|------|----|
| `SEARCH_ENGINE` | `remote` |
| `REMOTE_API_BASE_URL` | `https://mcp.tan-kim.com/namuwiki-api` |
| `REMOTE_API_TOKEN` | `<NAMU_API_TOKEN 과 동일 값>` |

> Vercel에는 **DB 자격증명을 두지 않는다.** 기존 `MYSQL_*`, `MEILISEARCH_*`는 삭제.
> 변경 후 **재배포** 필요.

### 3-3. 도메인 (api.tan-kim.com/namuwiki)

tan-kim 백엔드 `apps/backend/vercel.json`에 프록시 rewrite를 catch-all보다 먼저 추가:

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
| 내부 api (Vercel 전용) | `https://mcp.tan-kim.com/namuwiki-api` | Bearer (`NAMU_API_TOKEN`) |
| MCP (Claude) | `https://mcp.tan-kim.com/namuwiki` | Bearer (`NAMU_MCP_BEARER_TOKEN`) |

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
