// Neo4j driver implementation.

import type { DataSourceDriver, QueryResult, ExecuteResult, SchemaInfo } from "./interface.js";

interface Neo4jConfig {
  uri: string;
  username: string;
  password: string;
  database?: string;
}

export class Neo4jDriver implements DataSourceDriver {
  type = "neo4j";
  private driver: import("neo4j-driver").Driver | null = null;
  private cfg: Neo4jConfig;
  private dbName: string;

  constructor(cfg: Neo4jConfig) {
    this.cfg = cfg;
    this.dbName = cfg.database || "neo4j";
  }

  private async getDriver(): Promise<import("neo4j-driver").Driver> {
    if (!this.driver) {
      const neo4j = await import("neo4j-driver");
      this.driver = neo4j.default.driver(
        this.cfg.uri,
        neo4j.default.auth.basic(this.cfg.username, this.cfg.password),
      );
    }
    return this.driver;
  }

  private async session(mode: "READ" | "WRITE"): Promise<import("neo4j-driver").Session> {
    const d = await this.getDriver();
    const neo4j = await import("neo4j-driver");
    return d.session({
      database: this.dbName,
      defaultAccessMode: mode === "READ" ? neo4j.default.session.READ : neo4j.default.session.WRITE,
    });
  }

  private toPlain(v: unknown): unknown {
    if (v === null || v === undefined) return v;
    if (typeof v === "object" && v !== null && "toNumber" in v && typeof (v as { toNumber: unknown }).toNumber === "function") {
      return (v as { toNumber(): number }).toNumber();
    }
    if (typeof v === "object" && v !== null && "labels" in v && "properties" in v) {
      const node = v as { labels: string[]; properties: Record<string, unknown> };
      return { _labels: node.labels, ...this.mapObj(node.properties) };
    }
    if (typeof v === "object" && v !== null && "type" in v && "properties" in v && "start" in v) {
      const rel = v as { type: string; properties: Record<string, unknown> };
      return { _type: rel.type, ...this.mapObj(rel.properties) };
    }
    if (Array.isArray(v)) return v.map((x) => this.toPlain(x));
    if (typeof v === "object" && v !== null) return this.mapObj(v as Record<string, unknown>);
    return v;
  }

  private mapObj(obj: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = this.toPlain(v);
    return out;
  }

  async ping(): Promise<string | null> {
    try {
      const d = await this.getDriver();
      await d.verifyConnectivity();
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  async query(cypher: string, params?: Record<string, unknown>): Promise<QueryResult> {
    const s = await this.session("READ");
    try {
      const result = await s.run(cypher, params ?? {});
      const columns = result.records.length > 0 ? (result.records[0]!.keys as string[]) : [];
      const rows = result.records.map((r) => {
        const obj: Record<string, unknown> = {};
        for (const k of columns) obj[k] = this.toPlain(r.get(k));
        return obj;
      });
      return { columns, rows, rowCount: rows.length };
    } finally {
      await s.close();
    }
  }

  async execute(cypher: string, params?: Record<string, unknown>): Promise<ExecuteResult> {
    const s = await this.session("WRITE");
    try {
      const result = await s.run(cypher, params ?? {});
      const c = result.summary.counters.updates();
      const parts: string[] = [];
      if (c.nodesCreated) parts.push(`nodes created: ${c.nodesCreated}`);
      if (c.nodesDeleted) parts.push(`nodes deleted: ${c.nodesDeleted}`);
      if (c.relationshipsCreated) parts.push(`rels created: ${c.relationshipsCreated}`);
      if (c.relationshipsDeleted) parts.push(`rels deleted: ${c.relationshipsDeleted}`);
      if (c.propertiesSet) parts.push(`props set: ${c.propertiesSet}`);
      if (c.labelsAdded) parts.push(`labels added: ${c.labelsAdded}`);
      if (c.indexesAdded) parts.push(`indexes added: ${c.indexesAdded}`);
      if (c.constraintsAdded) parts.push(`constraints added: ${c.constraintsAdded}`);
      const total = c.nodesCreated + c.nodesDeleted + c.relationshipsCreated + c.relationshipsDeleted + c.propertiesSet;
      return { affectedRows: total, details: parts.join(", ") || "OK" };
    } finally {
      await s.close();
    }
  }

  async schema(detail?: string): Promise<SchemaInfo> {
    const s = await this.session("READ");
    try {
      const labels = await s.run("CALL db.labels() YIELD label RETURN label ORDER BY label");
      const rels = await s.run("CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType ORDER BY relationshipType");
      const countRes = await s.run("MATCH (n) RETURN count(n) as c");
      const relCountRes = await s.run("MATCH ()-[r]->() RETURN count(r) as c");
      const nodeCount = this.toPlain(countRes.records[0]?.get("c")) ?? 0;
      const relCount = this.toPlain(relCountRes.records[0]?.get("c")) ?? 0;

      const lines = [
        `# Neo4j Schema`,
        `Nodes: ${nodeCount} | Relationships: ${relCount}`,
        ``,
        `## Labels (${labels.records.length})`,
      ];

      for (const r of labels.records) {
        const label = r.get("label");
        if (detail === "full") {
          const cnt = await s.run(`MATCH (n:\`${label}\`) RETURN count(n) as c`);
          const c = this.toPlain(cnt.records[0]?.get("c")) ?? 0;
          const props = await s.run(`MATCH (n:\`${label}\`) WITH n LIMIT 100 UNWIND keys(n) AS key RETURN DISTINCT key ORDER BY key`);
          const propList = props.records.map((p) => p.get("key")).join(", ");
          lines.push(`- **:${label}** (${c}) — ${propList || "(no properties)"}`);
        } else {
          lines.push(`- :${label}`);
        }
      }

      lines.push(``, `## Relationships (${rels.records.length})`);
      if (detail === "full") {
        const relDetail = await s.run(
          `MATCH (a)-[r]->(b) RETURN DISTINCT labels(a)[0] AS from, type(r) AS rel, labels(b)[0] AS to, count(*) AS count ORDER BY count DESC LIMIT 50`
        );
        for (const r of relDetail.records) {
          lines.push(`- (:${r.get("from")})-[:${r.get("rel")}]->(:${r.get("to")})  ×${this.toPlain(r.get("count"))}`);
        }
      } else {
        for (const r of rels.records) lines.push(`- [:${r.get("relationshipType")}]`);
      }

      if (detail === "sample") {
        lines.push(``, `## Samples (5 per label)`);
        for (const r of labels.records) {
          const label = r.get("label");
          const samples = await s.run(`MATCH (n:\`${label}\`) RETURN properties(n) AS props LIMIT 5`);
          lines.push(`### :${label}`);
          for (const sr of samples.records) {
            lines.push(`  ${JSON.stringify(this.toPlain(sr.get("props")))}`);
          }
        }
      }

      return { text: lines.join("\n") };
    } finally {
      await s.close();
    }
  }

  async close(): Promise<void> {
    if (this.driver) {
      await this.driver.close();
      this.driver = null;
    }
  }
}
