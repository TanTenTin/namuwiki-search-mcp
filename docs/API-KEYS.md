# API 키 발급 정책

namuwiki 검색은 **사용자당 API 키 1개**로 인증한다. 같은 키로 **REST API와 MCP를 모두** 쓴다.

- REST: `Authorization: Bearer <API키>` 헤더로 호출
- MCP: 클라이언트 설정의 토큰을 MCP 서버가 namu-api로 **그대로 전달**(패스스루)

키는 RDS `api_keys` 테이블에 **SHA-256 해시로만** 저장된다. 원본 키는 **발급 응답에 한 번만** 노출되며 서버는 복구할 수 없다(분실 시 재발급).

---

## 키의 형태와 저장

| 컬럼 | 설명 |
|------|------|
| `key_hash` | 원본 키의 SHA-256(원본 미저장) |
| `name` | 소유자/용도 라벨 (예: `홍길동/블로그봇`) |
| `rate_per_min` | 이 키의 분당 요청 한도 (기본 120) |
| `active` | 활성 여부(폐기 시 0) |
| `last_used_at`, `request_count` | 사용량(주기적 일괄 반영) |

- 원본 키 형식: `nw_<랜덤>` (예: `nw_a1B2...`).
- 검증 결과는 서버에서 짧게 캐시(기본 60초)되어 요청마다 DB를 치지 않는다. 폐기는 캐시를 즉시 비워 반영한다.

---

## 발급 / 조회 / 폐기 (관리자)

`ADMIN_API_TOKEN`(서버 `infra/.env`)으로 보호되는 엔드포인트를 사용한다.
외부 경로는 `…/namuwiki/admin/keys`(Caddy가 `/namuwiki`를 떼고 namu-api `/admin/keys`로 전달).

### 발급

```bash
curl -X POST https://api.tan-kim.com/namuwiki/admin/keys \
  -H "Authorization: Bearer <ADMIN_API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"name":"홍길동/블로그봇","rate_per_min":120}'
```

응답(원본 키는 지금만 표시):

```json
{ "id": 1, "name": "홍길동/블로그봇", "rate_per_min": 120,
  "api_key": "nw_xxxxxxxx", "note": "api_key는 지금만 표시됩니다. 안전히 보관하세요." }
```

### 목록 (원본 키 미포함)

```bash
curl https://api.tan-kim.com/namuwiki/admin/keys \
  -H "Authorization: Bearer <ADMIN_API_TOKEN>"
```

### 폐기

```bash
curl -X DELETE https://api.tan-kim.com/namuwiki/admin/keys/1 \
  -H "Authorization: Bearer <ADMIN_API_TOKEN>"
```

---

## 사용 (발급받은 키)

### REST

```bash
curl "https://api.tan-kim.com/namuwiki/search?q=리눅스&limit=3" \
  -H "Authorization: Bearer <발급받은 API키>"
```

키가 없거나 틀리면 `401`. 헬스체크(`/namuwiki/health`)만 인증에서 제외된다.

### MCP (Claude)

`.mcp.json` 또는 Claude 설정에 사용자 키를 넣는다:

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

---

## 운영 정책 권장

- **키는 1인/1용도 단위로 발급**하고 `name`에 식별 정보를 남긴다(남용 추적·선택적 폐기 용이).
- **한도(`rate_per_min`)는 용도별로 차등**: 일반 120, 봇/배치는 협의 후 상향. 소형 서버이므로 전체 합이 처리량을 넘지 않게 관리한다.
- **유출 의심 시 즉시 폐기 후 재발급**. 폐기는 60초 내(캐시 TTL) 또는 즉시(폐기 시 캐시 비움) 반영된다.
- **`ADMIN_API_TOKEN`은 사용자에게 절대 공유 금지** — 키 발급/폐기 권한이다. 사용자에겐 발급된 `nw_...` 키만 전달한다.
- 부하가 커지면 [Cloudflare 프록시 + 캐싱](https://github.com/TanTenTin/caddy-config)으로 엣지에서 추가로 흡수한다.
