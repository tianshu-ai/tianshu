// Voice mode toggle — global zustand store, localStorage-persisted.
//
// Yu, 2026-09-19: introduced in feat/voice-conversation-mode after
// we abandoned the sherpa streaming ASR spike. The idea shifted:
// instead of shipping our own transcription pipeline, users rely on
// the OS-level dictation they already trust (macOS fn+fn, Windows
// Win+H) to fill the chat input, and tianshu adds VALUE by speaking
// the assistant's reply back with a good local TTS.
//
// Yu, 2026-09-20 01:23: rewrote from per-component useState +
// localStorage to a shared zustand store. The per-component version
// broke same-tab sync: React's useState is scoped to one component
// tree instance, and localStorage.setItem does NOT fire the
// "storage" event in the SAME tab (only other tabs). So when Yu
// clicked the voice-off toggle inside VoiceSubtitleView, that
// component's own state flipped but ChatArea's state stayed on,
// leaving ChatArea's early-return still active — the toggle
// looked frozen because ChatArea kept rendering
// <VoiceSubtitleView>. Zustand's store is a singleton observed by
// every subscriber, so a set() there re-renders both components.
//
// We keep this a per-device preference (not tenant config). If a
// user opens tianshu on their laptop and their phone, each is
// remembered separately.

import { create } from "zustand";

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

function writeStorage(v: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, v ? "1" : "0");
  } catch {
    // ignore — in-memory state still updates
  }
}

interface VoiceModeState {
  enabled: boolean;
  setEnabled: (v: boolean) => void;
  toggle: () => void;
}

const useVoiceModeStore = create<VoiceModeState>((set, get) => ({
  enabled: readInitial(),
  setEnabled: (v) => {
    writeStorage(v);
    set({ enabled: v });
  },
  toggle: () => {
    const next = !get().enabled;
    writeStorage(next);
    set({ enabled: next });
  },
}));

// Cross-tab sync: if the user flips the toggle in one tab, other
// open tabs pick up the change on next storage event. Registered
// module-level once so we don't re-add listeners on every hook call.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (ev) => {
    if (ev.key !== STORAGE_KEY) return;
    useVoiceModeStore.setState({ enabled: ev.newValue === "1" });
  });
}

// Backwards-compatible hook API. Callers (ChatArea, VoiceSubtitleView,
// ChatInput) keep using `const { enabled, toggle } = useVoiceMode()`
// without change.
export function useVoiceMode(): {
  enabled: boolean;
  setEnabled: (v: boolean) => void;
  toggle: () => void;
} {
  const enabled = useVoiceModeStore((s) => s.enabled);
  const setEnabled = useVoiceModeStore((s) => s.setEnabled);
  const toggle = useVoiceModeStore((s) => s.toggle);
  return { enabled, setEnabled, toggle };
}
