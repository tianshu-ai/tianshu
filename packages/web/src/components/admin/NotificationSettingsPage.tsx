// Notification settings page.
//
// A simple toggle for desktop notifications + permission status
// indicator + test button. All state lives in localStorage via
// the notification-store; no server round-trips needed.

import { useCallback } from "react";
import { Bell, BellOff, CheckCircle, Volume2, VolumeX, XCircle, AlertTriangle } from "lucide-react";
import { useNotificationStore } from "../../stores/notification-store";
import { useT } from "../../hooks/useT";

export default function NotificationSettingsPage() {
  const t = useT();
  const enabled = useNotificationStore((s) => s.enabled);
  const permission = useNotificationStore((s) => s.permission);
  const setEnabled = useNotificationStore((s) => s.setEnabled);
  const soundEnabled = useNotificationStore((s) => s.soundEnabled);
  const setSoundEnabled = useNotificationStore((s) => s.setSoundEnabled);
  const notify = useNotificationStore((s) => s.notify);
  const refreshPermission = useNotificationStore((s) => s.refreshPermission);

  const handleToggle = useCallback(async () => {
    await setEnabled(!enabled);
  }, [enabled, setEnabled]);

  const handleTest = useCallback(() => {
    // Refresh permission in case the user changed it externally.
    refreshPermission();
    // Fire a test notification (ignores the hidden-tab check).
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      try {
        const n = new Notification(t("notify.title"), {
          body: t("notify.settings.testBody"),
          icon: "/favicon.ico",
        });
        n.onclick = () => {
          window.focus();
          n.close();
        };
      } catch {
        /* swallow */
      }
    }
  }, [refreshPermission, t]);

  const permBadge = (() => {
    switch (permission) {
      case "granted":
        return (
          <span className="inline-flex items-center gap-1 text-xs text-green-500">
            <CheckCircle className="h-3.5 w-3.5" />
            {t("notify.settings.permGranted")}
          </span>
        );
      case "denied":
        return (
          <span className="inline-flex items-center gap-1 text-xs text-red-400">
            <XCircle className="h-3.5 w-3.5" />
            {t("notify.settings.permDenied")}
          </span>
        );
      case "unsupported":
        return (
          <span className="inline-flex items-center gap-1 text-xs text-yellow-500">
            <AlertTriangle className="h-3.5 w-3.5" />
            {t("notify.settings.permUnsupported")}
          </span>
        );
      default:
        return null; // "default" — no badge, prompt will appear on enable
    }
  })();

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      {/* Header */}
      <div>
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Bell className="h-5 w-5" />
          {t("notify.settings.title")}
        </h2>
        <p className="mt-1 text-sm text-text-secondary">
          {t("notify.settings.subtitle")}
        </p>
      </div>

      {/* Toggle card */}
      <div className="rounded-lg border border-border-subtle bg-bg-surface p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2 font-medium text-sm">
              {enabled ? (
                <Bell className="h-4 w-4 text-blue-500" />
              ) : (
                <BellOff className="h-4 w-4 text-text-tertiary" />
              )}
              {t("notify.settings.enable")}
            </div>
            <p className="text-xs text-text-tertiary max-w-md">
              {t("notify.settings.enableHint")}
            </p>
          </div>

          {/* Toggle switch */}
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            onClick={handleToggle}
            className={`
              relative inline-flex h-6 w-11 shrink-0 cursor-pointer
              rounded-full border-2 border-transparent transition-colors
              duration-200 ease-in-out focus-visible:outline-none
              focus-visible:ring-2 focus-visible:ring-blue-500
              focus-visible:ring-offset-2
              ${enabled ? "bg-blue-600" : "bg-gray-600"}
            `}
          >
            <span
              className={`
                pointer-events-none inline-block h-5 w-5 transform
                rounded-full bg-white shadow ring-0 transition
                duration-200 ease-in-out
                ${enabled ? "translate-x-5" : "translate-x-0"}
              `}
            />
          </button>
        </div>

        {/* Permission status */}
        {permBadge && <div className="pt-1">{permBadge}</div>}

        {/* Test button */}
        {enabled && permission === "granted" && (
          <button
            type="button"
            onClick={handleTest}
            className="mt-2 rounded-md border border-border-subtle bg-bg-raised
                       px-3 py-1.5 text-xs font-medium hover:bg-bg-elevated
                       transition-colors"
          >
            {t("notify.settings.test")}
          </button>
        )}
      </div>

      {/* Sound toggle card — only visible when notifications are on */}
      {enabled && (
        <div className="rounded-lg border border-border-subtle bg-bg-surface p-4">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <div className="flex items-center gap-2 font-medium text-sm">
                {soundEnabled ? (
                  <Volume2 className="h-4 w-4 text-blue-500" />
                ) : (
                  <VolumeX className="h-4 w-4 text-text-tertiary" />
                )}
                {t("notify.settings.sound")}
              </div>
              <p className="text-xs text-text-tertiary max-w-md">
                {t("notify.settings.soundHint")}
              </p>
            </div>

            <button
              type="button"
              role="switch"
              aria-checked={soundEnabled}
              onClick={() => setSoundEnabled(!soundEnabled)}
              className={`
                relative inline-flex h-6 w-11 shrink-0 cursor-pointer
                rounded-full border-2 border-transparent transition-colors
                duration-200 ease-in-out focus-visible:outline-none
                focus-visible:ring-2 focus-visible:ring-blue-500
                focus-visible:ring-offset-2
                ${soundEnabled ? "bg-blue-600" : "bg-gray-600"}
              `}
            >
              <span
                className={`
                  pointer-events-none inline-block h-5 w-5 transform
                  rounded-full bg-white shadow ring-0 transition
                  duration-200 ease-in-out
                  ${soundEnabled ? "translate-x-5" : "translate-x-0"}
                `}
              />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
