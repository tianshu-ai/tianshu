// Browser notification preferences.
//
// Persisted to localStorage so the setting survives reloads.
// The store also owns the tab-title-flash logic: when a reply
// completes while the tab is hidden, the title flips to
// "✅ 回复完成 - 天枢" until the user returns.

import { create } from "zustand";

const STORAGE_KEY = "tianshu.desktopNotifications";

function loadEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function storeEnabled(v: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, v ? "true" : "false");
  } catch {
    /* swallow */
  }
}

/** Current Notification.permission, or "unsupported" when the API
 *  is absent (e.g. non-secure context). */
export type NotificationPermission =
  | "default"
  | "granted"
  | "denied"
  | "unsupported";

function currentPermission(): NotificationPermission {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission as NotificationPermission;
}

// ── tab title flash ─────────────────────────────────────────────
let originalTitle: string | null = null;

function startTitleFlash(flashTitle: string): void {
  if (originalTitle !== null) return; // already flashing
  originalTitle = document.title;
  document.title = flashTitle;
}

function stopTitleFlash(): void {
  if (originalTitle === null) return;
  document.title = originalTitle;
  originalTitle = null;
}

// Listen for tab re-focus to restore the title.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) stopTitleFlash();
  });
}

// ── store ───────────────────────────────────────────────────────

interface NotificationState {
  enabled: boolean;
  permission: NotificationPermission;

  /** Toggle the setting. When turning on, requests permission if
   *  needed. Returns the resulting permission string. */
  setEnabled: (on: boolean) => Promise<NotificationPermission>;

  /** Refresh the cached permission (call after the user interacts
   *  with the browser prompt outside our UI). */
  refreshPermission: () => void;

  /** Fire a desktop notification + tab title flash. Called by the
   *  useNotifications hook when stream_end arrives on a hidden tab. */
  notify: (title: string, body: string, flashTitle: string) => void;
}

export const useNotificationStore = create<NotificationState>((set, get) => ({
  enabled: loadEnabled(),
  permission: currentPermission(),

  setEnabled: async (on) => {
    if (on && currentPermission() === "default") {
      try {
        await Notification.requestPermission();
      } catch {
        /* user dismissed or API error */
      }
    }
    const perm = currentPermission();
    storeEnabled(on);
    set({ enabled: on, permission: perm });
    return perm;
  },

  refreshPermission: () => set({ permission: currentPermission() }),

  notify: (title, body, flashTitle) => {
    const { enabled, permission } = get();
    if (!enabled) return;

    // Tab title flash (works regardless of notification permission).
    if (document.hidden) startTitleFlash(flashTitle);

    // Desktop notification.
    if (permission === "granted") {
      try {
        const n = new Notification(title, { body, icon: "/favicon.ico" });
        n.onclick = () => {
          window.focus();
          n.close();
        };
      } catch {
        /* swallow — e.g. service-worker-only env */
      }
    }
  },
}));
