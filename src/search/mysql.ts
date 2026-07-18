/**
 * MySQL 기반 검색 엔진 구현체.
 *
 * InnoDB의 FULLTEXT 인덱스 + ngram 파서를 사용한다.
 * ngram_token_size=2 환경에서는 한국어 2글자 검색이 정식 지원되므로
 * SQLite trigram(3글자)의 약점이 없다.
 *
 * 용량 최적화: 이 프로젝트가 사용하는 namuwiki-extracted는 이미 마크업이
 * 제거된 정제본이라, 원문(text_raw)을 따로 저장하지 않고 정제 텍스트(text)만
 * 보관한다. getArticle의 plain_text=false 요청에도 동일한 text를 반환한다.
 */

import mysql from "mysql2/promise";
import type { SearchEngine } from "./engine.js";
import { normalizeLimit } from "./engine.js";
import type {
  IndexedDocument,
  SearchResponse,
  ArticleResponse,
  SearchOptions,
} from "../types/index.js";
import { makeSnippet } from "../indexer/markup.js";
import { rerankHits, poolSizeFor } from "./rerank.js";
import { canonicalOf } from "./synonyms.js";

export interface MysqlConnectionConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/** 검색 SQL이 돌려주는 행 형태 */
interface SearchRow {
  title: string;
  text: string;
  score: number;
}

export class MysqlSearchEngine implements SearchEngine {
  private pool: mysql.Pool | null = null;

  constructor(private readonly conn: MysqlConnectionConfig) {}

  async init(): Promise<void> {
    this.pool = mysql.createPool({
      host: this.conn.host,
      port: this.conn.port,
      user: this.conn.user,
      password: this.conn.password,
      database: this.conn.database,
      charset: "utf8mb4",
      waitForConnections: true,
      // 재시도 중 hang된 커넥션이 쌓여도 여유가 있도록 넉넉히 둔다.
      connectionLimit: 10,
      multipleStatements: false,
      // 원격 RDS 장시간 연결 중 끊김 감지를 위해 TCP keepalive 활성화.
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
    });

    // 문서 테이블 생성. FULLTEXT 인덱스는 여기서 만들지 않는다.
    // 대량 인덱싱 중 매 INSERT마다 ngram 인덱스를 갱신하면 I/O가 폭증해
    // (특히 IOPS가 제한된 관리형 DB에서) stall이 발생하므로,
    // 데이터 적재가 끝난 뒤 buildFulltextIndex()로 한 번에 생성한다.
    // - text는 본문(정제). 긴 문서를 위해 MEDIUMTEXT(최대 16MB).
    // - title은 정확 매칭 조회용으로 prefix 인덱스를 둔다.
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS documents (
        id           VARCHAR(40)  NOT NULL,
        namespace    VARCHAR(255) NOT NULL,
        title        VARCHAR(512) NOT NULL,
        text         MEDIUMTEXT   NOT NULL,
        contributors MEDIUMTEXT   NOT NULL,
        PRIMARY KEY (id),
        KEY idx_title (title(255)),
        KEY idx_namespace (namespace)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  /**
   * ngram FULLTEXT 인덱스(ft_text)를 생성한다. 이미 있으면 아무것도 하지 않는다.
   *
   * 대량 적재가 끝난 뒤 한 번 호출한다. ALTER는 오래 걸릴 수 있으므로
   * 타임아웃을 걸지 않고 완료까지 기다린다.
   */
  async buildFulltextIndex(): Promise<void> {
    const pool = this.ensurePool();

    const [rows] = await pool.query(
      `SELECT COUNT(*) AS c FROM information_schema.STATISTICS
       WHERE table_schema = ? AND table_name = 'documents' AND index_name = 'ft_text'`,
      [this.conn.database],
    );
    if ((rows as Array<{ c: number }>)[0].c > 0) return; // 이미 존재

    await pool.query(
      `ALTER TABLE documents ADD FULLTEXT INDEX ft_text (title, text) WITH PARSER ngram`,
    );
  }

  private ensurePool(): mysql.Pool {
    if (!this.pool) throw new Error("MysqlSearchEngine가 초기화되지 않았습니다. init()을 먼저 호출하세요.");
    return this.pool;
  }

  async index(docs: IndexedDocument[]): Promise<void> {
    if (docs.length === 0) return;
    const pool = this.ensurePool();

    // 다중 행 INSERT ... ON DUPLICATE KEY UPDATE 로 배치 upsert.
    // text_raw는 이 엔진에서 저장하지 않는다(정제본이라 불필요).
    const placeholders = docs.map(() => "(?, ?, ?, ?, ?)").join(", ");
    const values: Array<string> = [];
    for (const d of docs) {
      values.push(
        d.id,
        d.namespace,
        d.title,
        d.text,
        JSON.stringify(d.contributors),
      );
    }

    const sql = `INSERT INTO documents (id, namespace, title, text, contributors)
       VALUES ${placeholders}
       ON DUPLICATE KEY UPDATE
         namespace = VALUES(namespace),
         title = VALUES(title),
         text = VALUES(text),
         contributors = VALUES(contributors)`;

    await this.execWithRetry(sql, values);
  }

  /**
   * 배치 INSERT를 타임아웃 + 재시도로 실행한다.
   *
   * 원격 RDS는 장시간 연결 중 네트워크 stall이 발생하면 쿼리가 무한 대기할 수
   * 있다(mysql2 자체 쿼리 타임아웃이 약함). Promise.race로 타임아웃을 걸고,
   * 실패 시 점진적 백오프로 재시도한다. upsert(ON DUPLICATE KEY)라 타임아웃 난
   * 쿼리가 실제로는 성공했더라도 재시도가 중복을 만들지 않는다.
   */
  private async execWithRetry(
    sql: string,
    values: Array<string>,
    attempt = 1,
  ): Promise<void> {
    const MAX_ATTEMPTS = 5;
    // 큰 문서가 몰린 배치는 INSERT가 오래 걸릴 수 있어 넉넉히 둔다.
    const TIMEOUT_MS = 90000;
    try {
      await this.queryWithTimeout(sql, values, TIMEOUT_MS);
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw err;
      console.error(
        `[mysql] 배치 INSERT 실패(시도 ${attempt}/${MAX_ATTEMPTS}): ` +
          `${err instanceof Error ? err.message : String(err)} → 재시도`,
      );
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      return this.execWithRetry(sql, values, attempt + 1);
    }
  }

  /** Promise.race로 쿼리에 강제 타임아웃을 건다. */
  private queryWithTimeout(
    sql: string,
    values: Array<string>,
    ms: number,
  ): Promise<void> {
    const pool = this.ensurePool();
    return Promise.race([
      pool.query(sql, values).then(() => undefined),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`쿼리 타임아웃(${ms}ms)`)), ms),
      ),
    ]);
  }

  async search(query: string, options?: SearchOptions): Promise<SearchResponse> {
    const pool = this.ensurePool();
    const limit = normalizeLimit(options?.limit);
    // 재정렬로 대표 문서를 끌어올리려면 후보를 넉넉히 조회해 풀에 담아야 한다.
    const poolSize = poolSizeFor(limit);

    // NATURAL LANGUAGE MODE: 사용자 입력의 특수문자를 연산자로 해석하지 않아 안전하다.
    // 같은 MATCH 식을 SELECT와 WHERE에 두 번 써도 옵티마이저가 한 번만 평가한다.
    const namespaceClause = options?.namespace ? "AND namespace = ?" : "";

    const poolParams: Array<string | number> = [query, query];
    if (options?.namespace) poolParams.push(options.namespace);
    poolParams.push(poolSize);

    // 검색어가 알려진 별칭이면 정식 문서 제목도 함께 완전일치 조회 대상에 넣는다.
    // (예: "BTS" → "방탄소년단". 요구사항 [2] 큐레이션 동의어)
    const canonical = canonicalOf(query);
    const exactTitles = canonical ? [query, canonical] : [query];

    // 전문검색 후보 풀 조회와, 제목 완전일치 문서 조회를 동시에 수행한다.
    // 제목 완전일치 문서는 본문 키워드 빈도가 낮아 풀에서 누락될 수 있으므로,
    // title 인덱스로 직접 찾아 반드시 후보에 포함시킨다 (요구사항 [1][2] 보장).
    const exactParams: Array<string> = [...exactTitles];
    if (options?.namespace) exactParams.push(options.namespace);
    const exactPlaceholders = exactTitles.map(() => "?").join(", ");

    const [poolResult, exactResult] = await Promise.all([
      pool.query(
        `SELECT
           title,
           text,
           MATCH(title, text) AGAINST(? IN NATURAL LANGUAGE MODE) AS score
         FROM documents
         WHERE MATCH(title, text) AGAINST(? IN NATURAL LANGUAGE MODE)
         ${namespaceClause}
         ORDER BY score DESC
         LIMIT ?`,
        poolParams,
      ),
      pool.query(
        `SELECT title, text, 0 AS score FROM documents
         WHERE title IN (${exactPlaceholders}) ${options?.namespace ? "AND namespace = ?" : ""}
         LIMIT 5`,
        exactParams,
      ),
    ]);

    const rows = poolResult[0] as SearchRow[];
    const exactRows = exactResult[0] as SearchRow[];

    // 제목 완전일치 문서(별칭의 정식 제목 포함)가 풀에 없으면 앞에 주입한다.
    // 표시 점수는 풀 최고 점수로 맞춰 상위 노출과 자연스러운 스코어를 유지한다
    // (재정렬이 티어0으로 끌어올림).
    const topScore = rows.length > 0 ? Number(rows[0].score) : 1;
    const injected = exactRows.filter((e) => !rows.some((r) => r.title === e.title));
    for (const e of injected) e.score = topScore;
    const candidates = injected.length > 0 ? [...injected, ...rows] : rows;

    const ranked = rerankHits(candidates, query, limit, canonical);
    const results = ranked.map((r) => ({
      title: r.title,
      snippet: makeSnippet(r.text, query, 300),
      score: Number(r.score),
    }));

    return { results, total: results.length };
  }

  async getArticle(title: string, _plainText = true): Promise<ArticleResponse> {
    const pool = this.ensurePool();

    const [rows] = await pool.query(
      `SELECT title, text, contributors FROM documents WHERE title = ? LIMIT 1`,
      [title],
    );
    const row = (rows as Array<{ title: string; text: string; contributors: string }>)[0];

    if (!row) {
      return { title, text: "", contributors: [], found: false };
    }

    // 정제본만 저장하므로 plain_text 여부와 무관하게 text를 반환한다.
    return {
      title: row.title,
      text: row.text,
      contributors: JSON.parse(row.contributors) as string[],
      found: true,
    };
  }

  async health(): Promise<boolean> {
    try {
      await this.ensurePool().query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool?.end();
    this.pool = null;
  }
}
