// Driver factory.

import type { ConnectionConfig, DataSourceDriver } from "./interface.js";
export type { DataSourceDriver, ConnectionConfig, QueryResult, ExecuteResult, SchemaInfo } from "./interface.js";

export async function createDriver(name: string, cfg: ConnectionConfig): Promise<DataSourceDriver> {
  switch (cfg.type) {
    case "neo4j": {
      const { Neo4jDriver } = await import("./neo4j.js");
      return new Neo4jDriver(cfg as unknown as ConstructorParameters<typeof Neo4jDriver>[0]);
    }
    case "mysql": {
      const { MysqlDriver } = await import("./mysql.js");
      return new MysqlDriver(cfg as unknown as ConstructorParameters<typeof MysqlDriver>[0]);
    }
    default:
      throw new Error(`Unknown datasource type: ${cfg.type}`);
  }
}
