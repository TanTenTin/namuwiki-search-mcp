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
      connectionLimit: 5,
      // 대량 배치 INSERT를 한 문장으로 보내기 위해 필요
      multipleStatements: false,
    });

    // 문서 테이블 + ngram FULLTEXT 인덱스 생성.
    // - text는 본문(정제). 긴 문서를 위해 MEDIUMTEXT(최대 16MB).
    // - FULLTEXT(title, text)에 ngram 파서를 지정해 한국어 부분 검색 지원.
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
        KEY idx_namespace (namespace),
        FULLTEXT KEY ft_text (title, text) WITH PARSER ngram
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
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

    await pool.query(
      `INSERT INTO documents (id, namespace, title, text, contributors)
       VALUES ${placeholders}
       ON DUPLICATE KEY UPDATE
         namespace = VALUES(namespace),
         title = VALUES(title),
         text = VALUES(text),
         contributors = VALUES(contributors)`,
      values,
    );
  }

  async search(query: string, options?: SearchOptions): Promise<SearchResponse> {
    const pool = this.ensurePool();
    const limit = normalizeLimit(options?.limit);

    // NATURAL LANGUAGE MODE: 사용자 입력의 특수문자를 연산자로 해석하지 않아 안전하다.
    // 같은 MATCH 식을 SELECT와 WHERE에 두 번 써도 옵티마이저가 한 번만 평가한다.
    const namespaceClause = options?.namespace ? "AND namespace = ?" : "";

    const params: Array<string | number> = [query, query];
    if (options?.namespace) params.push(options.namespace);
    params.push(limit);

    const [rows] = await pool.query(
      `SELECT
         title,
         text,
         MATCH(title, text) AGAINST(? IN NATURAL LANGUAGE MODE) AS score
       FROM documents
       WHERE MATCH(title, text) AGAINST(? IN NATURAL LANGUAGE MODE)
       ${namespaceClause}
       ORDER BY score DESC
       LIMIT ?`,
      params,
    );

    const results = (rows as SearchRow[]).map((r) => ({
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
