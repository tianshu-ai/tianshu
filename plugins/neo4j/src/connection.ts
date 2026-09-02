// Neo4j driver connection management.
// Lazy singleton: created on first use, shared across all tool calls.

import neo4j, { type Driver, type Session, type Config } from "neo4j-driver";

export interface Neo4jConfig {
  uri: string;
  username: string;
  password: string;
  database: string;
}

let _driver: Driver | null = null;
let _config: Neo4jConfig | null = null;

export function configure(cfg: Neo4jConfig): void {
  // If config changed, close old driver.
  if (_driver && JSON.stringify(cfg) !== JSON.stringify(_config)) {
    _driver.close().catch(() => {});
    _driver = null;
  }
  _config = cfg;
}

function getDriver(): Driver {
  if (!_config) throw new Error("Neo4j not configured");
  if (!_driver) {
    _driver = neo4j.driver(
      _config.uri,
      neo4j.auth.basic(_config.username, _config.password),
      {
        maxConnectionLifetime: 60 * 60 * 1000, // 1h
        maxConnectionPoolSize: 10,
        connectionAcquisitionTimeout: 10_000,
      } as Config,
    );
  }
  return _driver;
}

/** Get a session for read operations. */
export function readSession(): Session {
  return getDriver().session({
    database: _config!.database,
    defaultAccessMode: neo4j.session.READ,
  });
}

/** Get a session for write operations. */
export function writeSession(): Session {
  return getDriver().session({
    database: _config!.database,
    defaultAccessMode: neo4j.session.WRITE,
  });
}

/** Verify connectivity. Returns error message or null on success. */
export async function verifyConnectivity(): Promise<string | null> {
  try {
    const driver = getDriver();
    await driver.verifyConnectivity();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Close the driver on shutdown. */
export async function close(): Promise<void> {
  if (_driver) {
    await _driver.close();
    _driver = null;
  }
}
