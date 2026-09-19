// Voice mode toggle — persisted in localStorage.
//
// Yu, 2026-09-19: introduced in feat/voice-conversation-mode after
// we abandoned the sherpa streaming ASR spike. The idea shifted:
// instead of shipping our own transcription pipeline, users rely on
// the OS-level dictation they already trust (macOS fn+fn, Windows
// Win+H) to fill the chat input, and tianshu adds VALUE by speaking
// the assistant's reply back with a good local TTS.
//
// This hook is intentionally trivial — one boolean, one setter,
// localStorage-backed so the setting survives a tab reload. All
// the interesting behaviour lives in useTts (audio playback) and
// MessageBubble (auto-play when this flag is on).
//
// We do NOT wire this to the tenant config; voice mode is a
// per-device preference. If a user opens tianshu on their laptop
// and their phone, each is remembered separately.

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "tianshu.voiceMode";

function readInitial(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    // Private-mode Safari can throw here — bail to disabled rather
    // than surface an exception to render.
    return false;
  }
}

export function useVoiceMode(): {
  enabled: boolean;
  setEnabled: (v: boolean) => void;
  toggle: () => void;
} {
  const [enabled, setEnabledState] = useState<boolean>(readInitial);

  const setEnabled = useCallback((v: boolean) => {
    setEnabledState(v);
    try {
      window.localStorage.setItem(STORAGE_KEY, v ? "1" : "0");
    } catch {
      // ignore — state is still updated in-memory for this tab
    }
  }, []);

  const toggle = useCallback(() => {
    setEnabled(!enabled);
  }, [enabled, setEnabled]);

  // Cross-tab sync: if the user flips the toggle in one tab, other
  // open tabs pick up the change on next storage event. Cheap and
  // matches the way tianshu handles most localStorage-backed
  // preferences.
  useEffect(() => {
    function onStorage(ev: StorageEvent) {
      if (ev.key !== STORAGE_KEY) return;
      setEnabledState(ev.newValue === "1");
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return { enabled, setEnabled, toggle };
}
