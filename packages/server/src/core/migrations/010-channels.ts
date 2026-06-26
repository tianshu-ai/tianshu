// Migration 010 — channel system schema.
//
// Adds:
//   - sessions.channel_id      : non-null only for channel sessions
//                                ("feishu" / "telegram" / "wechat" / ...).
//                                NULL for in-app webchat / worker sessions.
//   - sessions.channel_chat_id : opaque chat handle from the platform.
//                                For DMs this is the sender id; for groups
//                                it's the group id. Stable per binding.
//   - sessions.channel_binding_id : back-ref to channel_bindings.id when
//                                set, so admins can see "which binding
//                                fed this session" and route outbound
//                                replies through the right credentials
//                                even if the same chat id appears in two
//                                accounts.
//
//   - channel_bindings (new table): one row per (tenant, channel,
//                                account). Lifecycle of an adapter
//                                instance: created on
//                                `channels login` / admin "Add",
//                                deleted on logout / unbind.
//
// The router uses (tenant_id, channel_id, channel_chat_id) to find or
// create channel sessions; older designs encoded these into a single
// `title` string but that's brittle (no uniqueness index, fuzzy
// parsing). With dedicated columns we can index the lookup and the
// row schema stays self-describing.

import type { Database } from "better-sqlite3";

export const ID = "010-channels";

export function up(db: Database): void {
  db.exec(`
    ALTER TABLE sessions ADD COLUMN channel_id          TEXT;
    ALTER TABLE sessions ADD COLUMN channel_chat_id     TEXT;
    ALTER TABLE sessions ADD COLUMN channel_binding_id  TEXT;

    -- Lookup index for the router's "find session by channel + chat" path.
    -- Includes channel_binding_id so two bindings for the same channel
    -- (e.g. two Telegram bots) keep their session spaces apart.
    CREATE INDEX idx_sessions_channel_lookup
      ON sessions(channel_binding_id, channel_id, channel_chat_id)
      WHERE channel_id IS NOT NULL;

    CREATE TABLE channel_bindings (
      id                TEXT PRIMARY KEY,
      tenant_id         TEXT NOT NULL,
      channel_id        TEXT NOT NULL,             -- e.g. "feishu", "wechat"
      plugin_id         TEXT NOT NULL,             -- plugin contributing this channel
      display_name      TEXT,                      -- admin label
      config            TEXT NOT NULL,             -- JSON-serialised adapter config (account credentials, etc.)
      enabled           INTEGER NOT NULL DEFAULT 1,
      status            TEXT NOT NULL DEFAULT 'idle', -- idle|starting|running|error|stopped
      status_detail     TEXT,                      -- last error / handshake message
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL
    );

    CREATE INDEX idx_channel_bindings_tenant
      ON channel_bindings(tenant_id, channel_id);
  `);
}
