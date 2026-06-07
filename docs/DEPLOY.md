# 배포 가이드

REST API와 MCP 서버를 모두 **AWS Lightsail**(기존 tan-kim 서버)에서 Docker로 운영한다.
검색 데이터는 **AWS RDS(MySQL)** 에 둔다. **Vercel은 더 이상 사용하지 않는다.**

- REST API : `api.tan-kim.com/namuwiki` 로 공개 노출 (rate-limit만, Bearer 없음)
- MCP 서버 : `mcp.tan-kim.com/namuwiki` 로 노출 (Caddy Bearer 보호)

TLS 종료/도메인 라우팅(Caddy)은 별도 [caddy-config](https://github.com/TanTenTin/caddy-config) 레포가 담당한다.
이 레포는 `api`/`mcp` 컨테이너만 배포하고, 공유 네트워크 `edge`로 Caddy와 연결된다.

## 아키텍처

```
┌─ Vercel ───────────┐        ┌─ AWS Lightsail (단일 VM) ───────────────────────────┐
│ tan-kim/frontend   │        │                                                      │
└─────────┬──────────┘        │  [caddy-config 레포] Caddy (80/443)                  │
          │ https://api.tan-kim.com    api.tan-kim.com/namuwiki  → namu-api:3000     │
          ▼                    │       mcp.tan-kim.com/namuwiki  → namu-mcp:3001 ─┐   │
   api.tan-kim.com ───────────►│                                  (Bearer)        │   │
   (검색 사용자)               │       edge 공유망 │        namu-internal 망       │   │
                               │  ┌──────────────┐ │ ┌──────────────┐ ┌──────────┐│   │
   Claude ──MCP+Bearer────────►│  │ namu-mcp      │─┼►│ namu-api      │ │ (this    ││   │
   mcp.tan-kim.com/namuwiki    │  └──────────────┘ │ └──────┬───────┘ │  repo)   ││   │
                               │                   │        │ MySQL    └──────────┘│   │
                               └───────────────────┼────────┼─────────────────────┘   │
                                                   │        ▼                          │
                                                   │  ┌────────────────────┐           │
                                                   │  │  AWS RDS (MySQL)    │           │
                                                   │  │  Lightsail IP만 허용│           │
                                                   │  └────────────────────┘           │
                                                   └───────────────────────────────────┘
```

- **REST API(namu-api)**: RDS(MySQL)에 연결해 검색을 수행한다. Caddy가 `/namuwiki` prefix를 제거하고 공개 노출한다.
- **MCP(namu-mcp)**: 내부 `namu-api:3000`을 호출하는 얇은 클라이언트. 공개 경로를 거치지 않는다.
- **RDS**: 보안 그룹에서 Lightsail 고정 IP만 3306 허용하면 된다.
- **포트 충돌 없음**: 호스트 포트 바인딩 없음. 외부 노출은 Caddy 경로뿐.

---

## 1. Lightsail 배포 (REST API + MCP)

### 1-1. 초기 서버 설정 (최초 1회)

```bash
ssh <AWS_USER>@<AWS_HOST>
git clone https://github.com/TanTenTin/namuwiki-search-mcp.git ~/namuwiki-search-mcp
nano ~/namuwiki-search-mcp/infra/.env   # infra/server-secrets.example 참고 (RDS 자격증명)
```

`infra/.env` (compose가 읽는다 — RDS 자격증명):

```env
MYSQL_HOST=your-namuwiki.xxxx.ap-northeast-2.rds.amazonaws.com
MYSQL_PORT=3306
MYSQL_USER=admin
MYSQL_PASSWORD=<RDS 비밀번호>
MYSQL_DATABASE=namuwiki
```

### 1-2. Caddy 연동 (caddy-config 레포)

Caddy는 별도 [caddy-config](https://github.com/TanTenTin/caddy-config) 레포가 소유한다.
namuwiki는 중립 공유망 `edge`로 그 Caddy와 연결된다. caddy-config의 `Caddyfile`이 이미
아래 두 경로를 노출한다:

- `api.tan-kim.com/namuwiki` → `namu-api:3000`  (공개, rate-limit)
- `mcp.tan-kim.com/namuwiki` → `namu-mcp:3001`  (`NAMU_MCP_BEARER_TOKEN` 보호)

MCP 보호 토큰은 **caddy-config 레포의 `~/caddy-config/.env`** 에 둔다 (이 레포가 아님):

```bash
# caddy-config 서버 측 .env
echo 'NAMU_MCP_BEARER_TOKEN=<랜덤 토큰>' >> ~/caddy-config/.env
cd ~/caddy-config && docker compose up -d && \
  docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile
```

### 1-3. 기동

```bash
cd ~/namuwiki-search-mcp
docker network create edge 2>/dev/null || true
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

## 엔드포인트 요약

| 용도 | URL | 인증 |
|------|-----|------|
| REST API 검색 | `https://api.tan-kim.com/namuwiki/search?q=...` | 없음 (rate-limit) |
| REST API 문서 | `https://api.tan-kim.com/namuwiki/article/<제목>` | 없음 |
| REST API 헬스 | `https://api.tan-kim.com/namuwiki/health` | 없음 |
| MCP (Claude) | `https://mcp.tan-kim.com/namuwiki` | Bearer (`NAMU_MCP_BEARER_TOKEN`) |

---

## 3. Claude Code에 MCP 등록

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
