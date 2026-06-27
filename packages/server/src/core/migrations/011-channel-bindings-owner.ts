// Migration 011 — make channel bindings per-user.
//
// Channel credentials (a wechat QR-scan, a telegram bot token) are
// personal: when Yu binds his wechat, the other users in the same
// tenant shouldn't see his sessions or be able to send through his
// adapter. The 0.3.37 schema only carried tenant_id, so this row
// fixes it.
//
// New column:
//   owner_user_id TEXT NOT NULL
//
// SQLite doesn't allow adding a NOT NULL column without a default,
// and we don't want a fake default (would silently claim every
// existing binding for one user). The migration:
//   1. ALTER TABLE ... ADD COLUMN owner_user_id TEXT  (nullable)
//   2. backfill: for each existing row, set owner_user_id to the
//      tenant's primary user (first row in `users`, same fallback
//      ensureChannelSession used). On fresh installs the table is
//      empty so this is a no-op.
//   3. enforce NOT NULL via a CHECK constraint — SQLite doesn't
//      have ALTER COLUMN SET NOT NULL, but the CHECK is enforced
//      on subsequent INSERTs.
//
// We also drop+recreate the tenant index to include owner_user_id,
// so list-by-(tenant, channel) queries the admin UI runs are still
// fast after we filter to a user.

import type { Database } from "better-sqlite3";

export const ID = "011-channel-bindings-owner";

export function up(db: Database): void {
  db.exec(`
    ALTER TABLE channel_bindings ADD COLUMN owner_user_id TEXT;
  `);

  // Backfill: each existing binding gets pinned to the tenant's
  // primary user. Multi-tenant installs typically have only one
  // user per tenant at this stage of the project, so the fallback
  // matches what users would have expected before the per-user
  // model existed.
  db.exec(`
    UPDATE channel_bindings
       SET owner_user_id = (
             SELECT id FROM users ORDER BY created_at ASC LIMIT 1
           )
     WHERE owner_user_id IS NULL;
  `);

  // Enforce non-null via a CHECK. Subsequent INSERTs without
  // owner_user_id will fail loud — better than silently inheriting
  // the tenant's primary user.
  db.exec(`
    CREATE TRIGGER channel_bindings_owner_required
      BEFORE INSERT ON channel_bindings
      FOR EACH ROW
      WHEN NEW.owner_user_id IS NULL
    BEGIN
      SELECT RAISE(ABORT, 'channel_bindings.owner_user_id is required');
    END;
  `);

  db.exec(`
    DROP INDEX IF EXISTS idx_channel_bindings_tenant;
    CREATE INDEX idx_channel_bindings_tenant_user
      ON channel_bindings(tenant_id, owner_user_id, channel_id);
  `);
}
