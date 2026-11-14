// Board sharing: track which boards are shared with which users.
//
// A board is identified by (owner_user_id, board_ref) where board_ref
// is the path like "my-board" or "group/my-board".
//
// Shared boards appear in the recipient's board list alongside their
// own boards, marked as shared. The recipient reads the owner's files
// directly (no copy), so changes are always in sync.

export const ID = "22";

export function up(db: import("better-sqlite3").Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS board_shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_user_id TEXT NOT NULL,
      board_ref TEXT NOT NULL,
      shared_with_user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      UNIQUE(owner_user_id, board_ref, shared_with_user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_board_shares_recipient
      ON board_shares(shared_with_user_id);
    CREATE INDEX IF NOT EXISTS idx_board_shares_owner
      ON board_shares(owner_user_id, board_ref);
  `);
}
