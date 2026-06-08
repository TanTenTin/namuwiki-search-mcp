# 배포 가이드

REST API와 MCP 서버를 모두 **AWS Lightsail**(기존 tan-kim 서버)에서 Docker로 운영한다.
**저장소 역할 분리**: 검색 데이터(`documents`)는 서버의 **SQLite**(덤프 — 언제든 재색인 가능)에 두고,
API 키(`api_keys`)와 사용 로그(`usage_logs`)는 **MySQL**(영속 — 유실되면 안 되는 운영 데이터)에 둔다.
**Vercel은 사용하지 않는다.**

- REST API : `api.tan-kim.com/namuwiki` — **API 키 필수**(rate-limit은 키별)
- MCP 서버 : `mcp.tan-kim.com/namuwiki` — 클라이언트가 설정한 **API 키를 그대로 전달**해 인증

키 발급/검증은 **RDS `api_keys` 테이블** 하나로 통일된다. 사용자당 키 1개로 REST·MCP를 모두 사용한다.
TLS 종료/도메인 라우팅(Caddy)은 별도 [caddy-config](https://github.com/TanTenTin/caddy-config) 레포가 담당한다.

## 아키텍처

```
[발급/폐기] 관리자 ─(ADMIN_API_TOKEN)→ namu-api /admin/keys ─→ RDS api_keys

[REST]  사용자 ─(Bearer <API키>)→ Caddy(api.tan-kim.com) ─pass→ namu-api ─검증→ RDS
[MCP]   Claude ─(Bearer <API키>)→ Caddy(mcp.tan-kim.com) ─pass→ namu-mcp
                                                                  └(토큰 그대로)→ namu-api ─검증→ RDS
```

- **namu-api**: 검색 로직 단일 소스. 모든 비-`/health` 요청에 API 키를 검증하고, 키별 rate-limit + 응답 캐시 + 동시성 상한 + 요청 타임아웃으로 소형 서버를 보호한다.
- **namu-mcp**: 자체 인증이 없다. Claude 클라이언트가 보낸 `Authorization` 토큰을 namu-api 호출에 그대로 첨부(패스스루)한다.
- **Caddy**: TLS 종료 + `Authorization` 헤더 패스스루. (별도 공유 토큰 검증 없음 — 검증은 namu-api가 단일 수행)

---

## 1. Lightsail 배포

### 1-1. 초기 서버 설정 (최초 1회)

```bash
ssh <AWS_USER>@<AWS_HOST>
git clone https://github.com/TanTenTin/namuwiki-search-mcp.git ~/namuwiki-search-mcp
nano ~/namuwiki-search-mcp/infra/.env   # infra/.env.example 참고
```

`infra/.env` (compose가 읽음):

```env
# MySQL (api_keys + usage_logs용). 검색은 SQLite라 검색용 DB는 필요 없다.
MYSQL_HOST=your-namuwiki.xxxx.ap-northeast-2.rds.amazonaws.com
MYSQL_PORT=3306
MYSQL_USER=admin
MYSQL_PASSWORD=<MySQL 비밀번호>
MYSQL_DATABASE=namuwiki
# API 키
REQUIRE_API_KEY=true
ADMIN_API_TOKEN=<강력한 랜덤 관리자 토큰>   # /admin/keys 보호 (사용자 키 발급/폐기용)
```

> 검색용 SQLite 파일은 compose가 named volume(`namu-data`)을 `/data`에 마운트하고
> `SQLITE_DB_PATH=/data/namuwiki.db`로 고정하므로 `.env`에 따로 지정할 필요가 없다.

### 1-2. 기동 + 인덱싱

```bash
cd ~/namuwiki-search-mcp
docker network create edge 2>/dev/null || true
docker compose -f infra/docker-compose.yml build
docker compose -f infra/docker-compose.yml up -d --remove-orphans

# SQLite 인덱싱 — 서버의 /data 볼륨에 직접 색인한다(HF parquet 스트리밍).
# 56만 건 전체. 로컬→서버 전송 없이 컨테이너 안에서 색인한다.
docker compose -f infra/docker-compose.yml exec api npm run index -- --source huggingface
```

> SQLite FTS5는 INSERT 시 점진적으로 색인되므로 별도 FULLTEXT 빌드(ALTER) 단계가 없다.
> 색인이 끝나면 바로 검색이 가능하다. 2글자 검색은 trigram이 못 잡으면 LIKE 폴백으로 처리된다.

### 1-3. API 키 발급

`ADMIN_API_TOKEN`으로 사용자 키를 발급한다. 자세한 정책은 [API-KEYS.md](API-KEYS.md) 참고.

```bash
# 발급 (원본 키는 응답에 1회만 표시됨)
curl -X POST https://api.tan-kim.com/namuwiki/admin/keys \
  -H "Authorization: Bearer <ADMIN_API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"name":"홍길동/실험용","rate_per_min":120}'
```

> Caddy가 `/namuwiki` prefix를 떼고 namu-api로 넘기므로, 외부 경로는 `…/namuwiki/admin/keys`이고 내부 라우트는 `/admin/keys`다.

### 1-4. Caddy(caddy-config) 연동

Caddy는 [caddy-config](https://github.com/TanTenTin/caddy-config)가 소유한다. namuwiki는 공유망 `edge`로 연결되고, Caddy는 다음을 노출한다(둘 다 `Authorization` 패스스루):

- `api.tan-kim.com/namuwiki` → `namu-api:3000`
- `mcp.tan-kim.com/namuwiki` → `namu-mcp:3001`

caddy-config 측 시크릿은 `CF_API_TOKEN`(Cloudflare DNS-01용)뿐이다. **과거 `NAMU_MCP_BEARER_TOKEN`은 폐기**됐다(MCP는 API 키 패스스루로 인증).

---

## 2. GitHub Actions 자동 배포

`main` push 시 `deploy-aws.yml`: typecheck → rsync → `docker compose build && up`.

| Secret | 값 |
|--------|----|
| `AWS_HOST` | Lightsail 공인 IP |
| `AWS_USER` | SSH 유저명 |
| `AWS_SSH_KEY` | SSH 개인키 전체 |

> ⚠️ 인덱싱이 진행 중일 때 배포하면 `docker compose up`이 api 컨테이너를 재생성해 인덱싱이 중단된다. 인덱싱 완료 후 배포할 것.

---

## 엔드포인트 요약

| 용도 | URL | 인증 |
|------|-----|------|
| REST 검색 | `https://api.tan-kim.com/namuwiki/search?q=...` | Bearer `<API키>` |
| REST 문서 | `https://api.tan-kim.com/namuwiki/article/<제목>` | Bearer `<API키>` |
| REST 헬스 | `https://api.tan-kim.com/namuwiki/health` | 없음(인증 제외) |
| 키 발급/폐기 | `https://api.tan-kim.com/namuwiki/admin/keys` | Bearer `<ADMIN_API_TOKEN>` |
| MCP (Claude) | `https://mcp.tan-kim.com/namuwiki` | Bearer `<API키>` |

---

## 3. Claude Code에 MCP 등록

`<API키>`는 `/admin/keys`로 발급받은 사용자 키다(관리자 토큰이 아님).

```json
{
  "mcpServers": {
    "namuwiki": {
      "type": "http",
      "url": "https://mcp.tan-kim.com/namuwiki",
      "headers": { "Authorization": "Bearer <발급받은 API키>" }
    }
  }
}
```
