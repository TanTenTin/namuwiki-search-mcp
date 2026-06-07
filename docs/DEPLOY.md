# 배포 가이드

REST API는 **Vercel**, MCP 서버 + 검색엔진(Meilisearch)은 **AWS Lightsail**(기존 tan-kim 서버)에 배포한다.
외부 노출은 기존 `mcp.tan-kim.com` 도메인 아래 **경로 기반**으로 통합한다.

## 아키텍처

```
┌────────────────────────┐         ┌──────────────────────────────────────────────┐
│  Vercel (무료)         │         │  AWS Lightsail (기존 tan-kim 서버)            │
│  REST API              │         │  ┌──────────────────────────────────────────┐ │
│  (검색 직접 수행)      │ ──HTTPS→│  │  Caddy (기존, 80/443)                     │ │
│                        │ +APIkey │  │   /namuwiki        → namu-mcp:3001         │ │
│                        │         │  │   /namuwiki-meili  → namu-meilisearch:7700 │ │
└────────────────────────┘         │  └───────────┬──────────────────────────────┘ │
                                    │              │ caddy-shared (공유 도커망)     │
   Claude Code ──MCP HTTP+Bearer──→ │  ┌───────────┴──────────────────────────────┐ │
   (/namuwiki)                      │  │ namu-mcp:3001 ─→ namu-api:3000             │ │
                                    │  │                       │                   │ │
                                    │  │           namu-meilisearch:7700 ◄─────────┘ │
                                    │  │           (namu-internal 도커망)            │ │
                                    │  └──────────────────────────────────────────┘ │
                                    └──────────────────────────────────────────────┘
```

- **경로 기반 통합**: 별도 서브도메인 없이 `mcp.tan-kim.com` 하나로 노출.
  - `https://mcp.tan-kim.com/namuwiki` → MCP 서버 (Bearer 토큰 보호)
  - `https://mcp.tan-kim.com/namuwiki-meili` → Meilisearch (Vercel 전용, Meilisearch API key 보호)
- **Vercel REST API**: 검색을 직접 수행. Caddy로 노출된 Meilisearch를 search-only API key로 호출.
- **MCP 서버**: Lightsail 내부 `namu-api:3000`을 직접 호출 (Vercel 왕복 없음).
- **포트 충돌 없음**: compose에 호스트 포트 바인딩이 전혀 없다. 모든 통신은 도커 네트워크 + 기존 Caddy 경유.

---

## 1. Lightsail 배포 (MCP + Meilisearch)

### 1-1. 초기 서버 설정 (최초 1회)

```bash
ssh <AWS_USER>@<AWS_HOST>

# 레포 클론
git clone https://github.com/<owner>/namuwiki-search-mcp.git ~/namuwiki-search-mcp

# compose 환경변수 배치 (infra/server-secrets.example 참고)
nano ~/namuwiki-search-mcp/infra/.env
```

`infra/.env` 내용 (compose가 읽는다):

```env
MEILISEARCH_API_KEY=<강력한 랜덤 마스터 키>
MEILISEARCH_INDEX=namuwiki
```

> `NAMU_MCP_BEARER_TOKEN`은 compose가 아니라 **Caddy 컨테이너** 환경에 넣는다 (1-2 참고).

### 1-2. Caddy 연동 (외부 노출)

기존 tan-kim Caddy가 80/443을 점유하므로 **별도 Caddy를 띄우지 않고** 기존 Caddy에 합친다.

1. **공유 네트워크명 확인** — namuwiki 컨테이너가 기존 Caddy와 같은 도커 네트워크에 있어야 한다:
   ```bash
   docker network ls
   # 기존 Caddy가 붙은 네트워크명 확인 (tan-kim이 infra/에서 실행되면 보통 infra_internal)
   docker inspect <caddy_container_name> --format '{{json .NetworkSettings.Networks}}'
   ```
2. `infra/docker-compose.yml` 하단 `caddy-shared.name` 값을 위에서 확인한 실제 네트워크명으로 교체.
3. **Caddyfile에 블록 추가** — `infra/Caddyfile.snippet` 내용을 기존 Caddyfile에 추가.
   이미 `mcp.tan-kim.com {}` 블록이 있으면 그 안에 `handle` 두 개만 넣는다.
4. **Caddy 컨테이너에 토큰 주입** — 기존 Caddy compose의 environment에 추가:
   ```yaml
   environment:
     NAMU_MCP_BEARER_TOKEN: <강력한 랜덤 토큰>
   ```
5. Caddy reload:
   ```bash
   docker compose -f <기존 caddy compose> up -d
   # 또는 docker exec <caddy> caddy reload --config /etc/caddy/Caddyfile
   ```

### 1-3. 기동

```bash
cd ~/namuwiki-search-mcp
docker compose -f infra/docker-compose.yml build
docker compose -f infra/docker-compose.yml up -d
```

### 1-4. 데이터 인덱싱

```bash
# api 컨테이너 안에서 인덱싱 스크립트 실행 (HuggingFace 소스 예시)
docker compose -f infra/docker-compose.yml exec api npm run index -- --source huggingface
```

---

## 2. GitHub Actions 자동 배포

`main` 브랜치에 서버 관련 경로(`src/`, `infra/`, `Dockerfile` 등)가 push되면
`deploy-aws.yml`이 typecheck → rsync → `docker compose build && up`을 수행한다.

### 필요한 Secrets

| Secret | 값 |
|--------|----|
| `AWS_HOST` | Lightsail 공인 IP |
| `AWS_USER` | SSH 유저명 (예: `ubuntu`) |
| `AWS_SSH_KEY` | SSH 개인키 전체 내용 |

---

## 3. Vercel 배포 (REST API)

### 3-1. 프로젝트 연결

Vercel 대시보드에서 이 레포를 import. `vercel.json`이 모든 경로를 `api/index.ts`로 라우팅한다.

### 3-2. 환경변수

| 변수 | 값 |
|------|----|
| `SEARCH_ENGINE` | `meilisearch` |
| `MEILISEARCH_HOST` | `https://mcp.tan-kim.com/namuwiki-meili` |
| `MEILISEARCH_API_KEY` | Meilisearch **search-only** API key (마스터 키 대신) |
| `MEILISEARCH_INDEX` | `namuwiki` |

> search-only 키 발급: Meilisearch `/keys` API로 `search` 액션만 가진 키를 만들어 사용.
> 마스터 키를 Vercel에 두면 외부에서 인덱스 변경이 가능해지므로 지양.

### 3-3. 배포

Vercel Git 연동이 main push를 자동 감지해 배포한다 (별도 워크플로우 불필요).

---

## 4. Claude Code에 MCP 등록

원격 MCP 서버는 Streamable HTTP로 노출된다. `~/.claude.json` 또는 프로젝트 `.mcp.json`에:

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

---

## 엔드포인트 요약

| 용도 | URL | 인증 |
|------|-----|------|
| REST API (외부) | `https://<vercel앱>.vercel.app/search?q=...` | 없음 (필요 시 추가) |
| MCP (Claude) | `https://mcp.tan-kim.com/namuwiki` | Bearer 토큰 |
| Meilisearch (Vercel용) | `https://mcp.tan-kim.com/namuwiki-meili` | Meilisearch API key |
