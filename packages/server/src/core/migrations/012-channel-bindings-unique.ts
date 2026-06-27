// Migration 012 — enforce "one binding per (tenant, user, channel)"
// at the schema level.
//
// 0.3.38 made bindings per-user; now we lock down the invariant
// each user has at most one active binding per channel. Two bindings
// for the same wechat scan would race the long-poll loop and
// duplicate every agent reply — there's no legitimate use case
// for it.
//
// The capability layer (host.channelBindings.create) already
// cascade-deletes existing bindings for the tuple before
// inserting, so the unique constraint is belt + braces: a
// misbehaving plugin or a direct SQL insert can't sneak around
// the policy.

import type { Database } from "better-sqlite3";

export const ID = "012-channel-bindings-unique";

export function up(db: Database): void {
  db.exec(`
    CREATE UNIQUE INDEX channel_bindings_unique_per_user
      ON channel_bindings(tenant_id, owner_user_id, channel_id);
  `);
}
