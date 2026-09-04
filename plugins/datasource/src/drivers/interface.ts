// Unified driver interface for all data sources.

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
}

export interface ExecuteResult {
  affectedRows: number;
  details: string;
}

export interface SchemaInfo {
  text: string; // Markdown-formatted schema
}

export interface DataSourceDriver {
  type: string;
  /** Test connectivity. Returns null on success, error message on failure. */
  ping(): Promise<string | null>;
  /** Read-only query. */
  query(sql: string, params?: Record<string, unknown>): Promise<QueryResult>;
  /** Write / DDL. */
  execute(sql: string, params?: Record<string, unknown>): Promise<ExecuteResult>;
  /** Inspect schema. */
  schema(detail?: string): Promise<SchemaInfo>;
  /** Close connections. */
  close(): Promise<void>;
}

export interface ConnectionConfig {
  type: "neo4j" | "mysql";
  description?: string;
  [key: string]: unknown;
}
