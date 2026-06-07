# namuwiki-search-mcp 공용 이미지.
# API 서버와 MCP 서버가 같은 이미지를 쓰고, 실행 커맨드만 docker-compose에서 분기한다.
#
# tsx로 TypeScript를 직접 실행하므로 별도 빌드 산출물(dist)은 만들지 않는다.
# better-sqlite3(네이티브 모듈) 컴파일을 위해 빌드 도구가 필요하다.
FROM node:20-slim

# 네이티브 모듈(better-sqlite3) 빌드용 도구.
# 프로덕션은 meilisearch 엔진을 쓰지만, 의존성에 포함돼 있어 설치 시 컴파일된다.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 의존성 레이어 캐시: package 파일만 먼저 복사.
# tsx로 런타임 실행하므로 devDependencies(tsx)도 필요 → --omit=dev 사용 안 함.
COPY package.json package-lock.json* ./
RUN npm install

# 애플리케이션 소스
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

# 기본값은 API 서버. compose에서 command로 mcp 실행을 덮어쓴다.
CMD ["npm", "run", "api"]
