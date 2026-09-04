// MySQL driver implementation using mysql2.

import type { DataSourceDriver, QueryResult, ExecuteResult, SchemaInfo } from "./interface.js";

interface MysqlConfig {
  host: string;
  port?: number;
  username: string;
  password: string;
  database: string;
}

export class MysqlDriver implements DataSourceDriver {
  type = "mysql";
  private pool: import("mysql2/promise").Pool | null = null;
  private cfg: MysqlConfig;

  constructor(cfg: MysqlConfig) {
    this.cfg = cfg;
  }

  private async getPool(): Promise<import("mysql2/promise").Pool> {
    if (!this.pool) {
      const mysql = await import("mysql2/promise");
      this.pool = mysql.createPool({
        host: this.cfg.host,
        port: this.cfg.port ?? 3306,
        user: this.cfg.username,
        password: this.cfg.password,
        database: this.cfg.database,
        waitForConnections: true,
        connectionLimit: 5,
        idleTimeout: 60000,
      });
    }
    return this.pool;
  }

  async ping(): Promise<string | null> {
    try {
      const pool = await this.getPool();
      const conn = await pool.getConnection();
      await conn.ping();
      conn.release();
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  async query(sql: string, params?: Record<string, unknown>): Promise<QueryResult> {
    const pool = await this.getPool();
    // Convert named params to positional if needed
    const { text, values } = namedToPositional(sql, params);
    const [rows, fields] = await pool.query({ sql: text, values } as never);
    const arr = Array.isArray(rows) ? rows : [];
    const columns = fields && Array.isArray(fields) ? fields.map((f: { name: string }) => f.name) : [];
    return {
      columns,
      rows: arr as Record<string, unknown>[],
      rowCount: arr.length,
    };
  }

  async execute(sql: string, params?: Record<string, unknown>): Promise<ExecuteResult> {
    const pool = await this.getPool();
    const { text, values } = namedToPositional(sql, params);
    const [result] = await pool.execute({ sql: text, values } as never);
    const r = result as { affectedRows?: number; changedRows?: number; insertId?: number };
    const parts: string[] = [];
    if (r.affectedRows) parts.push(`affected: ${r.affectedRows}`);
    if (r.changedRows) parts.push(`changed: ${r.changedRows}`);
    if (r.insertId) parts.push(`insertId: ${r.insertId}`);
    return {
      affectedRows: r.affectedRows ?? 0,
      details: parts.join(", ") || "OK",
    };
  }

  async schema(detail?: string): Promise<SchemaInfo> {
    const pool = await this.getPool();
    const db = this.cfg.database;

    // Tables
    const [tables] = await pool.query(
      `SELECT TABLE_NAME, TABLE_ROWS, TABLE_COMMENT
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
      [db],
    );
    const tableList = tables as Array<{ TABLE_NAME: string; TABLE_ROWS: number; TABLE_COMMENT: string }>;

    const lines = [
      `# MySQL Schema: ${db}`,
      `Tables: ${tableList.length}`,
      ``,
    ];

    for (const t of tableList) {
      const comment = t.TABLE_COMMENT ? ` — ${t.TABLE_COMMENT}` : "";
      lines.push(`## ${t.TABLE_NAME} (~${t.TABLE_ROWS ?? "?"} rows)${comment}`);

      if (detail === "full" || detail === "sample") {
        // Columns
        const [cols] = await pool.query(
          `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, COLUMN_COMMENT
           FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
          [db, t.TABLE_NAME],
        );
        const colList = cols as Array<{
          COLUMN_NAME: string; COLUMN_TYPE: string; IS_NULLABLE: string;
          COLUMN_KEY: string; COLUMN_DEFAULT: string | null; COLUMN_COMMENT: string;
        }>;

        lines.push(`| Column | Type | Key | Nullable | Comment |`);
        lines.push(`|---|---|---|---|---|`);
        for (const c of colList) {
          const key = c.COLUMN_KEY === "PRI" ? "🔑 PK" : c.COLUMN_KEY === "MUL" ? "FK" : c.COLUMN_KEY === "UNI" ? "UQ" : "";
          lines.push(`| ${c.COLUMN_NAME} | ${c.COLUMN_TYPE} | ${key} | ${c.IS_NULLABLE} | ${c.COLUMN_COMMENT || ""} |`);
        }
        lines.push(``);

        // Indexes
        const [idxs] = await pool.query(`SHOW INDEX FROM \`${t.TABLE_NAME}\``);
        const idxList = idxs as Array<{ Key_name: string; Column_name: string; Non_unique: number }>;
        const idxMap = new Map<string, { cols: string[]; unique: boolean }>();
        for (const idx of idxList) {
          if (!idxMap.has(idx.Key_name)) idxMap.set(idx.Key_name, { cols: [], unique: !idx.Non_unique });
          idxMap.get(idx.Key_name)!.cols.push(idx.Column_name);
        }
        if (idxMap.size > 0) {
          lines.push(`Indexes:`);
          for (const [name, info] of idxMap) {
            lines.push(`- ${name}${info.unique ? " (UNIQUE)" : ""}: (${info.cols.join(", ")})`);
          }
          lines.push(``);
        }
      }

      if (detail === "sample") {
        const [sampleRows] = await pool.query(`SELECT * FROM \`${t.TABLE_NAME}\` LIMIT 3`);
        const samples = sampleRows as Record<string, unknown>[];
        if (samples.length > 0) {
          lines.push(`Sample rows:`);
          for (const row of samples) {
            lines.push(`  ${JSON.stringify(row)}`);
          }
          lines.push(``);
        }
      }
    }

    return { text: lines.join("\n") };
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}

/** Convert `:name` style params to `?` positional for mysql2. */
function namedToPositional(sql: string, params?: Record<string, unknown>): { text: string; values: unknown[] } {
  if (!params || Object.keys(params).length === 0) return { text: sql, values: [] };
  const values: unknown[] = [];
  const text = sql.replace(/:(\w+)/g, (_, name) => {
    values.push(params[name] ?? null);
    return "?";
  });
  return { text, values };
}
