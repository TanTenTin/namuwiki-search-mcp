/**
 * SQLite FTS5 기반 검색 엔진 구현체.
 *
 * 외부 서비스 없이 단일 파일 DB로 동작하므로 로컬 테스트의 기본 엔진으로 적합하다.
 * FTS5 가상 테이블에 정제 텍스트를 색인하고, BM25 점수로 관련도를 산출한다.
 *
 * 한국어 토크나이징 한계:
 *   SQLite 기본 FTS5는 한국어 형태소 분석을 지원하지 않는다.
 *   여기서는 trigram 토크나이저를 사용해 부분 문자열 매칭이 되도록 한다.
 *   (정밀 검색이 필요하면 Meilisearch 엔진을 사용한다.)
 */

import Database from "better-sqlite3";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type { SearchEngine } from "./engine.js";
import { normalizeLimit } from "./engine.js";
import type {
  IndexedDocument,
  SearchResponse,
  ArticleResponse,
  SearchOptions,
} from "../types/index.js";
import { makeSnippet } from "../indexer/markup.js";

/** search/likeSearch가 공통으로 반환하는 내부 행 형태 */
interface SearchRow {
  title: string;
  text: string;
  score: number;
}

export class SqliteSearchEngine implements SearchEngine {
  private db: Database.Database | null = null;

  constructor(private readonly dbPath: string) {}

  async init(): Promise<void> {
    // DB 파일이 위치할 디렉토리를 보장한다.
    mkdirSync(dirname(this.dbPath), { recursive: true });

    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");

    // 본문/메타데이터 저장 테이블.
    // 정제본 데이터셋이라 원문(text_raw)을 따로 저장하지 않고 정제 텍스트(text)만 둔다.
    // (text_raw와 text가 거의 동일해 중복이며, 디스크 용량을 크게 절감한다.)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id           TEXT PRIMARY KEY,
        namespace    TEXT NOT NULL,
        title        TEXT NOT NULL,
        text         TEXT NOT NULL,
        contributors TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_documents_title ON documents(title);

      -- FTS5 가상 테이블: trigram 토크나이저로 한국어 부분 매칭 지원.
      -- 독립 FTS 테이블로 두고 documents.rowid와 동일한 rowid로 동기화한다.
      -- (external-content 모드는 삭제 동기화가 까다로워 손상 위험이 있어 쓰지 않는다.)
      CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
        title,
        text,
        tokenize='trigram'
      );
    `);
  }

  private ensureDb(): Database.Database {
    if (!this.db) throw new Error("SqliteSearchEngine가 초기화되지 않았습니다. init()을 먼저 호출하세요.");
    return this.db;
  }

  async index(docs: IndexedDocument[]): Promise<void> {
    const db = this.ensureDb();

    // 본문 테이블 upsert + FTS 동기화를 트랜잭션으로 묶는다.
    const insertDoc = db.prepare(`
      INSERT INTO documents (id, namespace, title, text, contributors)
      VALUES (@id, @namespace, @title, @text, @contributors)
      ON CONFLICT(id) DO UPDATE SET
        namespace=excluded.namespace,
        title=excluded.title,
        text=excluded.text,
        contributors=excluded.contributors
    `);

    // FTS는 rowid 기준으로 동기화한다. 단순화를 위해 매 배치에서
    // 해당 문서의 rowid를 조회해 FTS 행을 갱신한다.
    const getRowid = db.prepare(`SELECT rowid FROM documents WHERE id = ?`);
    const deleteFts = db.prepare(`DELETE FROM documents_fts WHERE rowid = ?`);
    const insertFts = db.prepare(`
      INSERT INTO documents_fts (rowid, title, text) VALUES (?, ?, ?)
    `);

    const txn = db.transaction((batch: IndexedDocument[]) => {
      for (const doc of batch) {
        insertDoc.run({
          id: doc.id,
          namespace: doc.namespace,
          title: doc.title,
          text: doc.text,
          contributors: JSON.stringify(doc.contributors),
        });
        const row = getRowid.get(doc.id) as { rowid: number } | undefined;
        if (row) {
          deleteFts.run(row.rowid);
          insertFts.run(row.rowid, doc.title, doc.text);
        }
      }
    });

    txn(docs);
  }

  async search(query: string, options?: SearchOptions): Promise<SearchResponse> {
    const db = this.ensureDb();
    const limit = normalizeLimit(options?.limit);

    // FTS5 MATCH 쿼리. 사용자 입력을 안전하게 처리하기 위해 큰따옴표로 감싸
    // 특수문자(연산자)로 해석되지 않도록 한다. trigram이므로 부분 매칭이 된다.
    const ftsQuery = `"${query.replace(/"/g, '""')}"`;

    // namespace 필터가 있으면 JOIN 조건에 추가한다.
    const namespaceClause = options?.namespace ? `AND d.namespace = @namespace` : "";

    // bm25()는 값이 작을수록 관련도가 높다. 출력 score는 직관적으로
    // 높을수록 관련도가 높게 보이도록 부호를 뒤집어 -bm25를 사용한다.
    const stmt = db.prepare(`
      SELECT
        d.title       AS title,
        d.text        AS text,
        -bm25(documents_fts) AS score
      FROM documents_fts
      JOIN documents d ON d.rowid = documents_fts.rowid
      WHERE documents_fts MATCH @q
      ${namespaceClause}
      ORDER BY bm25(documents_fts)
      LIMIT @limit
    `);

    let rows: SearchRow[];
    try {
      rows = stmt.all({
        q: ftsQuery,
        limit,
        ...(options?.namespace ? { namespace: options.namespace } : {}),
      }) as SearchRow[];
    } catch {
      // 쿼리 구문 오류(특수문자 등)로 MATCH가 실패하면 빈 결과로 처리한다.
      rows = [];
    }

    // FTS5 trigram 토크나이저는 3글자 미만 쿼리에서 토큰을 만들지 못해
    // 매칭이 0건이 된다. 이 경우 LIKE 부분 일치로 폴백한다.
    if (rows.length === 0) {
      rows = this.likeSearch(query, limit, options?.namespace);
    }

    const results = rows.map((r) => ({
      title: r.title,
      snippet: makeSnippet(r.text, query, 300),
      score: r.score,
    }));

    return { results, total: results.length };
  }

  /**
   * LIKE 기반 부분 일치 폴백 검색.
   *
   * FTS가 매칭하지 못하는 짧은 쿼리(2글자 이하 등)를 처리한다.
   * 점수는 단순화하여 제목 일치(2.0)를 본문 일치(1.0)보다 우선하고,
   * 같은 점수면 더 짧은(핵심적인) 문서를 앞에 둔다.
   */
  private likeSearch(
    query: string,
    limit: number,
    namespace?: string,
  ): SearchRow[] {
    const db = this.ensureDb();

    // LIKE 와일드카드(%, _)와 이스케이프 문자(\)를 리터럴로 처리한다.
    const escaped = query.replace(/[\\%_]/g, (c) => `\\${c}`);
    const pattern = `%${escaped}%`;

    const namespaceClause = namespace ? `AND namespace = @namespace` : "";

    const stmt = db.prepare(`
      SELECT
        title,
        text,
        CASE WHEN title LIKE @pattern ESCAPE '\\' THEN 2.0 ELSE 1.0 END AS score
      FROM documents
      WHERE (title LIKE @pattern ESCAPE '\\' OR text LIKE @pattern ESCAPE '\\')
      ${namespaceClause}
      ORDER BY score DESC, length(text) ASC
      LIMIT @limit
    `);

    return stmt.all({
      pattern,
      limit,
      ...(namespace ? { namespace } : {}),
    }) as SearchRow[];
  }

  async getArticle(title: string, _plainText = true): Promise<ArticleResponse> {
    const db = this.ensureDb();

    const stmt = db.prepare(`
      SELECT title, text, contributors
      FROM documents
      WHERE title = ?
      LIMIT 1
    `);
    const row = stmt.get(title) as
      | { title: string; text: string; contributors: string }
      | undefined;

    if (!row) {
      // 프로젝트 규칙: 미발견 시 404가 아니라 found:false 반환
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
      this.ensureDb().prepare("SELECT 1").get();
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }
}
