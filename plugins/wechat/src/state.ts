// Per-binding state persistence.
//
// Each binding owns a `stateDir` (provided by the host's adapter
// manager) where we keep:
//   - account.json       : bot token + iLink user id + display
//                          name. Written on successful QR login.
//   - sync-buf.txt       : opaque cursor for getUpdates. Updated
//                          on every long-poll round so the poll
//                          resumes correctly after restart.
//   - context-tokens.json: { ilink_user_id: contextToken } map.
//                          Each inbound message refreshes its
//                          entry; outbound sends look up the
//                          recipient's token.
//
// The host's adapter manager guarantees the stateDir exists
// before the factory runs.

import fs from "node:fs";
import path from "node:path";

export interface AccountFile {
  token: string;
  ilinkUserId?: string;
  username?: string;
  loggedInAt: number;
}

const ACCOUNT_FILENAME = "account.json";
const SYNC_BUF_FILENAME = "sync-buf.txt";
const CTX_TOKENS_FILENAME = "context-tokens.json";

export class WeChatState {
  constructor(public readonly stateDir: string) {}

  // ── account.json ─────────────────────────────────────────────

  loadAccount(): AccountFile | null {
    const filePath = path.join(this.stateDir, ACCOUNT_FILENAME);
    if (!fs.existsSync(filePath)) return null;
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<AccountFile>;
      if (typeof parsed.token === "string" && parsed.token) {
        return {
          token: parsed.token,
          ilinkUserId: parsed.ilinkUserId,
          username: parsed.username,
          loggedInAt: parsed.loggedInAt ?? Date.now(),
        };
      }
    } catch {
      /* swallow */
    }
    return null;
  }

  saveAccount(account: AccountFile): void {
    fs.mkdirSync(this.stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(this.stateDir, ACCOUNT_FILENAME),
      JSON.stringify(account, null, 2),
      "utf-8",
    );
  }

  clearAccount(): void {
    const filePath = path.join(this.stateDir, ACCOUNT_FILENAME);
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* not found is fine */
    }
  }

  // ── sync-buf.txt ─────────────────────────────────────────────

  loadSyncBuf(): string {
    const filePath = path.join(this.stateDir, SYNC_BUF_FILENAME);
    if (!fs.existsSync(filePath)) return "";
    try {
      return fs.readFileSync(filePath, "utf-8");
    } catch {
      return "";
    }
  }

  saveSyncBuf(buf: string): void {
    fs.mkdirSync(this.stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(this.stateDir, SYNC_BUF_FILENAME),
      buf,
      "utf-8",
    );
  }

  // ── context-tokens.json ─────────────────────────────────────

  loadContextTokens(): Record<string, string> {
    const filePath = path.join(this.stateDir, CTX_TOKENS_FILENAME);
    if (!fs.existsSync(filePath)) return {};
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, string>;
      }
    } catch {
      /* swallow */
    }
    return {};
  }

  saveContextTokens(map: Record<string, string>): void {
    fs.mkdirSync(this.stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(this.stateDir, CTX_TOKENS_FILENAME),
      JSON.stringify(map, null, 0),
      "utf-8",
    );
  }
}
