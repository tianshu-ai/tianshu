// Client-side plugin authoring types. Imported as
// `@tianshu-ai/plugin-sdk/client`.
//
// The chat shell's PluginRegistry expects a plugin's client module to
// export a `components` map keyed by the strings used in the manifest's
// `contributes.{rightPanels|sidebarSections|composerActions}.component`.

import type { ComponentType } from "react";

export interface PluginRuntimeInfo {
  id: string;
  version: string;
  displayName: string;
}

export interface PanelProps {
  tenantId: string;
  userId: string;
  plugin: PluginRuntimeInfo;
}

export interface SidebarSectionProps extends PanelProps {
  isCollapsed: boolean;
  onToggleCollapse: () => void;
}

/**
 * Props handed to a plugin's admin-page component
 * (manifest.contributes.adminPages[].component). The host renders
 * these inside the chat shell's `/admin` shell, full-width.
 */
export interface AdminPageProps extends PanelProps {
  /** The page id from the manifest contribution
   *  (e.g. "main", "settings"). */
  pageId: string;
}

// ── Composer (chat input) extensions ───────────────────────────────

/**
 * One file (or, in the future, any other inline payload) the user
 * has staged in the composer. The chat shell renders these as chips
 * above the textarea and disables Send until everything is `ready`.
 *
 * Plugins create attachments via `composer.addAttachment(...)` and
 * track upload progress by calling `updateAttachment(id, patch)`.
 */
export interface Attachment {
  /** Stable id assigned by the host on `addAttachment`. */
  id: string;
  name: string;
  size: number;
  status: "uploading" | "ready" | "error";
  /**
   * Path relative to the user's home (e.g. `/uploads/data.csv`).
   * Populated by the plugin once the file is on disk.
   */
  path?: string;
  /**
   * RFC 6838 mime type. The host forwards this on the wire so the
   * server can decide whether to treat the attachment as a vision
   * input or a plain workspace file. Plugins should pass
   * `File.type` here when available; default to
   * `"application/octet-stream"`.
   */
  mimeType?: string;
  /** 0..1, optional progress for the chip. */
  progress?: number;
  /** Set when status === "error". */
  error?: string;
  /** Plugin-defined metadata (dimensions, hashes, anything). */
  meta?: Record<string, unknown>;
}

export type DraftTransform = (
  /** The text the user typed (already trimmed of trailing whitespace). */
  text: string,
  /** All attachments at the moment of send, all with status === "ready". */
  attachments: Attachment[],
) => string | Promise<string>;

/**
 * Composer API surface exposed to plugin client components.
 *
 * Implementation note: the host wires this into a React context. Use
 * `useComposer()` from `@tianshu-ai/plugin-sdk/client` from inside a
 * plugin component to get the live instance.
 */
export interface ComposerApi {
  /** Live attachments list. Mutations should go through the methods. */
  attachments: Attachment[];
  /** Append a new attachment, host assigns the id. */
  addAttachment(a: Omit<Attachment, "id">): string;
  /** Patch fields on an existing attachment. No-op if id unknown. */
  updateAttachment(id: string, patch: Partial<Omit<Attachment, "id">>): void;
  /** Remove an attachment from the staged list. */
  removeAttachment(id: string): void;
  /**
   * Register a transform that runs (in order of registration) on the
   * draft text right before it's sent to the server. Returns an
   * unregister function. Idempotent when called repeatedly with the
   * same fn.
   */
  registerDraftTransform(fn: DraftTransform): () => void;
}

export interface ComposerActionProps extends PanelProps {
  composer: ComposerApi;
}

// ─── Attachment renderers ────────────────────────────────────────────────

/**
 * One attachment as it lands in a user message. Mirrors the wire
 * shape; the host re-exports it here so plugin authors only depend
 * on the SDK.
 */
export interface AttachmentDescriptor {
  /** User-home-relative path (always starts with "/"). */
  path: string;
  /** RFC 6838 mime type. */
  mimeType: string;
  /** Original filename for display. */
  name?: string;
  /** Byte size on disk, when known. */
  size?: number;
}

export interface AttachmentRendererProps extends PanelProps {
  attachment: AttachmentDescriptor;
  /** "start" for assistant-side, "end" for user-side. The renderer
   *  doesn't need to align itself — the host wraps a flex
   *  container — but it can use this for asymmetrical decoration. */
  align: "start" | "end";
  /**
   * Resolve a workspace path to an absolute URL the browser can
   * fetch. The host owns this so renderer plugins don't hard-code
   * `/api/p/files/raw` (which would couple them to the files
   * plugin). Today the host implementation routes through the
   * files plugin; tomorrow it might route through a CDN cache.
   */
  rawUrl: (path: string) => string;
}

export interface PluginClientExports {
  components: Record<
    string,
    ComponentType<
      | PanelProps
      | SidebarSectionProps
      | ComposerActionProps
      | AttachmentRendererProps
      | AdminPageProps
    >
  >;
}

// `useComposer` is implemented by the host (web bundle) and re-exported
// here as a typed declaration so plugin authors `import { useComposer }
// from "@tianshu-ai/plugin-sdk/client"`. The host swaps the implementation
// in via __installUseComposer().
//
// The accessor lives on `globalThis` instead of a module-local
// `let` so that plugin packages with a transitively-duplicated SDK
// copy still see the host's installed implementation. If the host
// installed first into globalThis, *any* import of @tianshu-ai/plugin-sdk/client
// resolves to the same accessor.
//
// Runtime contract: host calls `__installUseComposer` exactly once
// at bootstrap. Plugins call `useComposer` from inside a React
// component rendered under the composer; the host's accessor reads
// from its React context.

interface ComposerGlobalSlot {
  __tianshuPluginSdkComposer__?: () => ComposerApi;
}

function globalSlot(): ComposerGlobalSlot {
  // `globalThis` is the same in node, browser, and worker runtimes.
  return globalThis as unknown as ComposerGlobalSlot;
}

/** Host-only: install the live `useComposer` accessor. The web bundle
 *  calls this once on bootstrap with a function that reads from its
 *  React context. */
export function __installUseComposer(fn: () => ComposerApi): void {
  globalSlot().__tianshuPluginSdkComposer__ = fn;
}

/** Host-only: clear the installed accessor. Used by tests so each
 *  test starts with a clean slate; production code should never
 *  call this. */
export function __resetUseComposerForTest(): void {
  delete globalSlot().__tianshuPluginSdkComposer__;
}

export function useComposer(): ComposerApi {
  const fn = globalSlot().__tianshuPluginSdkComposer__;
  if (!fn) {
    throw new Error(
      "useComposer() called without a host: plugin SDK has no live ComposerApi. " +
        "If you are seeing this in a test, install one with __installUseComposer().",
    );
  }
  return fn();
}

// ─── OpenFile capability ────────────────────────────────────────
//
// Intent-style file open. Anyone (workboard task cards, attachment
// renderers, future apps) can ask the host to "open this workspace
// file" without knowing what "open" means in the current shell.
// The Files plugin registers the actual implementation — a modal
// preview dialog — by calling __installOpenFileApi() at mount
// time; until that runs (or if Files isn't enabled in this tenant)
// the host's bootstrap fallback opens the raw URL in a new tab.
// Same install-once + globalSlot trick we use for useComposer so
// duplicated SDK copies in plugin bundles still see the same hook.

export interface OpenFileApi {
  /** Open a file living inside the user workspace. `path` accepts
   *  the same shapes the file tools accept: a `workspace:///foo`
   *  URI, a leading-slash absolute path, or a bare relative path.
   *  Implementations may render an in-page modal, switch to the
   *  files panel, open a new tab — anything UX-appropriate. */
  open(path: string): void;
}

interface OpenFileGlobalSlot {
  __tianshuPluginSdkOpenFile__?: OpenFileApi;
}

function openFileSlot(): OpenFileGlobalSlot {
  return globalThis as unknown as OpenFileGlobalSlot;
}

/** Host or files-plugin only: register an OpenFileApi. The host
 *  installs a fallback at bootstrap; the Files plugin overrides
 *  it on mount with its dialog-based implementation. Last writer
 *  wins. */
export function __installOpenFileApi(api: OpenFileApi): void {
  openFileSlot().__tianshuPluginSdkOpenFile__ = api;
}

/** Test helper. */
export function __resetOpenFileApiForTest(): void {
  delete openFileSlot().__tianshuPluginSdkOpenFile__;
}

/** Hook returning the live `open(path)` callable. Stable across
 *  re-renders — always reads from the slot, so a late
 *  __installOpenFileApi() takes effect on the next call without
 *  forcing a re-mount. Throws only if absolutely no implementation
 *  has ever been installed (which means the host bootstrap was
 *  skipped). */
// ─── PluginConfigForm — re-export of the host's auto-generated
// config form, exposed so a plugin's own admin page can fold it
// in alongside its richer UI (Sandbox status / build history /
// etc.) instead of getting a duplicated "Settings" sidebar entry.
//
// Same install-once + globalSlot trick. Host installs the
// component on bootstrap; plugin imports `PluginConfigForm` and
// renders <PluginConfigForm pluginId="microsandbox" /> wherever
// makes sense. The form looks up its own data from the live
// plugin store, so the plugin only needs to pass the id.

import * as React from "react";

export interface PluginConfigFormProps {
  /** Plugin id (matches manifest.id). Form pulls schema + values
   *  from the host's live plugin store on every render, so a
   *  config save in another tab updates this in place. */
  pluginId: string;
  /** Optional className applied to the root form container. */
  className?: string;
}

interface PluginConfigFormGlobalSlot {
  __tianshuPluginSdkPluginConfigForm__?: React.ComponentType<PluginConfigFormProps>;
}

function pluginConfigFormSlot(): PluginConfigFormGlobalSlot {
  return globalThis as unknown as PluginConfigFormGlobalSlot;
}

export function __installPluginConfigForm(
  C: React.ComponentType<PluginConfigFormProps>,
): void {
  pluginConfigFormSlot().__tianshuPluginSdkPluginConfigForm__ = C;
}

export function __resetPluginConfigFormForTest(): void {
  delete pluginConfigFormSlot().__tianshuPluginSdkPluginConfigForm__;
}

/** Renders the auto-generated config form for `pluginId`. If the
 *  plugin has no `configSchema` or no fields, renders nothing
 *  (so the calling component can drop it in unconditionally). */
export const PluginConfigForm: React.ComponentType<PluginConfigFormProps> =
  (props) => {
    const C = pluginConfigFormSlot().__tianshuPluginSdkPluginConfigForm__;
    if (!C) return null;
    return React.createElement(C, props);
  };

export function useOpenFile(): OpenFileApi["open"] {
  return (path: string): void => {
    const api = openFileSlot().__tianshuPluginSdkOpenFile__;
    if (!api) {
      // Last-resort UX so the click does *something* useful even
      // before any registrar has installed: stick the path in the
      // URL bar of a new tab. Never reachable in production where
      // the host installs a fallback at bootstrap.
      const cleaned = path.replace(/^workspace:\/\/+/, "/");
      const url = `/api/p/files/raw?path=${encodeURIComponent(cleaned)}`;
      window.open(url, "_blank", "noopener");
      return;
    }
    api.open(path);
  };
}

// ─── UiPrimitives — host-provided React components plugins reuse
//
// Every plugin that needs a modal / a document viewer / a markdown
// rendering surface used to roll its own copy. The result was
// five subtly-different `fixed inset-0 z-50 bg-black/...` modals,
// two different markdown renderers, and zero consistency between
// what the user sees in chat vs. the files preview vs. the
// workboard task history.
//
// This module exposes a single hook — `useUiPrimitives()` — that
// returns the host's canonical React components. The host
// installs them once at bootstrap via __installUiPrimitives. The
// hook is safe to call from any plugin's React tree and stable
// across re-renders.
//
// Why a hook rather than a direct import:
//   plugins are loaded as separate ESM modules at runtime. They
//   share the *types* in @tianshu-ai/plugin-sdk but not the
//   compiled React component bundle — the host's bundle owns
//   that. Same install-once + globalSlot pattern as useComposer
//   and PluginConfigForm.

export interface ModalProps {
  /** Whether the modal is rendered. Caller controls visibility;
   *  the modal does not animate or remember anything when this
   *  flips. */
  isOpen: boolean;
  /** Fired when the user dismisses the modal (ESC, backdrop
   *  click, or the X button). The host does NOT auto-close on
   *  this — the caller must flip `isOpen` to false themselves. */
  onClose: () => void;
  /** Optional title rendered in the header. When omitted the
   *  modal still renders a close button in the top-right. */
  title?: string;
  /** Size preset. Defaults to "md".
   *    sm   : narrow, content-driven (e.g. confirmations)
   *    md   : comfortable reading width (default)
   *    lg   : wide content (file previews, code)
   *    xl   : near full-screen (transcripts, long history) */
  size?: "sm" | "md" | "lg" | "xl";
  /** Modal body. Caller fully controls layout inside. */
  children: React.ReactNode;
  /** Optional className merged onto the inner content panel
   *  (NOT the backdrop). Lets callers tune background, padding,
   *  or override the default min-height. */
  className?: string;
  /** Hide the default header (title + X). Use when the caller
   *  renders its own header / chrome inside `children` and doesn't
   *  want a doubled-up close affordance. The Modal still closes
   *  on ESC and backdrop click. */
  hideHeader?: boolean;
  /** Optional extra controls rendered in the header to the LEFT
   *  of the close button. Typical use: a download <a> for file
   *  previews. Ignored when `hideHeader` is true (caller is
   *  expected to render its own header in that case). */
  headerActions?: React.ReactNode;
  /** When true (default), the Modal shows a maximize / restore
   *  toggle in the header so the user can expand it to fill the
   *  viewport. Set to false to suppress the button for modals
   *  that should stay at a fixed size (e.g. tiny confirmations).
   *  Ignored when `hideHeader` is true. */
  allowMaximize?: boolean;
}

export interface DocumentViewerProps {
  /** The file content. String for text/markdown/code; null while
   *  loading or for binary files the host already determined are
   *  unviewable. */
  content: string | null;
  /** Optional MIME type hint. When absent the viewer falls back
   *  to extension sniffing via `filename`. */
  mimeType?: string;
  /** Optional filename hint, used for extension sniffing when
   *  `mimeType` is absent and for the markdown vs. plain-text
   *  dispatch (only `.md` / `.markdown` get rendered as
   *  Markdown; everything else falls through to plain text). */
  filename?: string;
  /** Set to true when the host already knows the content is
   *  binary and unrenderable (e.g. images served through a
   *  different surface). The viewer shows a placeholder. */
  binary?: boolean;
  /** Set to true while the host is fetching content. Viewer
   *  shows a spinner. */
  loading?: boolean;
  /** Error message from the loader, if any. Viewer renders it
   *  in place of the content. */
  error?: string | null;
  /** Optional total bytes; surfaced in the binary placeholder
   *  and the "too large" error path. */
  sizeBytes?: number;
  /** Optional URL the host can stream the raw file bytes from.
   *  Required for image / pdf / video / audio surfaces (the
   *  viewer renders <img> / <iframe> / <video> / <audio>
   *  against this URL). When the file is text and `content` is
   *  provided, `rawUrl` is unused. */
  rawUrl?: string;
  /** Optional className merged onto the viewer root. */
  className?: string;
}

export interface MarkdownBlockProps {
  /** Markdown source. */
  children: string;
  /** Optional className merged onto the prose container. */
  className?: string;
  /** Skip the default prose typography classes. Useful when the
   *  caller wraps MarkdownBlock in its own prose container
   *  (chat-bubble style) and a double-wrap would compound the
   *  styles. Default false — standalone use gets prose for free. */
  noProse?: boolean;
}

export interface UiPrimitives {
  Modal: React.ComponentType<ModalProps>;
  DocumentViewer: React.ComponentType<DocumentViewerProps>;
  MarkdownBlock: React.ComponentType<MarkdownBlockProps>;
}

interface UiPrimitivesGlobalSlot {
  __tianshuPluginSdkUiPrimitives__?: UiPrimitives;
}

function uiPrimitivesSlot(): UiPrimitivesGlobalSlot {
  return globalThis as unknown as UiPrimitivesGlobalSlot;
}

/** Host-only: install the canonical UiPrimitives. Called by the
 *  web bundle at boot. Last writer wins. */
export function __installUiPrimitives(api: UiPrimitives): void {
  uiPrimitivesSlot().__tianshuPluginSdkUiPrimitives__ = api;
}

/** Test helper. */
export function __resetUiPrimitivesForTest(): void {
  delete uiPrimitivesSlot().__tianshuPluginSdkUiPrimitives__;
}

/** Hook returning the live primitives. Throws if the host has
 *  not installed any — in production this is impossible because
 *  the web bundle installs them at bootstrap; in tests, callers
 *  install a stub via `__installUiPrimitives`. */
export function useUiPrimitives(): UiPrimitives {
  const api = uiPrimitivesSlot().__tianshuPluginSdkUiPrimitives__;
  if (!api) {
    throw new Error(
      "useUiPrimitives() called without a host: plugin SDK has no live UiPrimitives. " +
        "If you are seeing this in a test, install a stub with __installUiPrimitives({ Modal, DocumentViewer, MarkdownBlock }).",
    );
  }
  return api;
}

// ─── Theme ─ host-managed light/dark switch surfaced to plugins
//
// The host writes `data-theme="dark" | "light"` to <html>; CSS
// variables in index.css switch as a side effect. Plugins that
// want to react in JS (e.g. shiki-highlighted code blocks that
// re-render with a different highlight theme) read the resolved
// value here through useTheme().
//
// **Plugin authoring rule**: do NOT hardcode `bg-gray-900` /
// `text-gray-100` / etc. Use the semantic token utilities
// (`bg-bg-base`, `bg-bg-elevated`, `text-fg-default`,
// `text-fg-muted`, `border-border-default`, `bg-accent`, etc.).
// They're declared via Tailwind 4 `@theme` in the host's CSS,
// pull values from CSS vars per theme, and follow the user's
// theme choice automatically.
//
// The complete semantic token list (host-side):
//
//   Backgrounds         Foregrounds        Borders
//   bg-bg-base          text-fg-default    border-border-default
//   bg-bg-elevated      text-fg-muted      border-border-strong
//   bg-bg-raised        text-fg-faint      border-border-subtle
//   bg-bg-hover         text-fg-fainter
//   bg-bg-overlay       text-fg-on-accent
//
//   Accent              State              Misc
//   bg-accent           text-success       text-link
//   bg-accent-hover     text-warning
//   bg-accent-faint     text-danger
//
// The `brand-50..900` ramp is still available as utilities
// (`bg-brand-600`) for places that need a fixed accent ramp
// across themes (rare); prefer `bg-accent` for new code.

export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export interface ThemeApi {
  /** What's actively painted. Always "light" or "dark"; the
   *  "system" mode resolves to one of these via the OS
   *  preference. */
  resolved: ResolvedTheme;
  /** What the user picked. Three values: "light", "dark",
   *  "system". When "system", `resolved` follows the OS. */
  mode: ThemeMode;
  /** Programmatic switch. Persists to localStorage host-side. */
  setMode: (mode: ThemeMode) => void;
}

interface ThemeGlobalSlot {
  __tianshuPluginSdkThemeHook__?: () => ThemeApi;
}

function themeSlot(): ThemeGlobalSlot {
  return globalThis as unknown as ThemeGlobalSlot;
}

/** Host installs this once at bootstrap. The function it provides
 *  is itself a React hook (zustand selector under the hood), so
 *  plugin code can call `useTheme()` from inside their components
 *  and re-render when the theme flips. */
export function __installUseTheme(fn: () => ThemeApi): void {
  themeSlot().__tianshuPluginSdkThemeHook__ = fn;
}

/** Test helper. */
export function __resetUseThemeForTest(): void {
  delete themeSlot().__tianshuPluginSdkThemeHook__;
}

/** Hook plugins call. Returns the live theme state; re-renders
 *  the consuming component on theme change. */
export function useTheme(): ThemeApi {
  const fn = themeSlot().__tianshuPluginSdkThemeHook__;
  if (!fn) {
    // No-op fallback for tests / pre-install boot. Plugins
    // calling useTheme before the host installs see "dark" —
    // matches our installed-default behaviour.
    return {
      resolved: "dark",
      mode: "system",
      setMode: () => {},
    };
  }
  return fn();
}

// ─── ChatNav — host-managed selection of which session the chat
// area is currently viewing.
//
// Channel plugins call `setViewingSession(sessionId)` from their
// sidebar sections so clicking a row pins the chat area to that
// session. `viewingSessionId === null` means the user's webchat
// thread.
//
// Same install-once + globalSlot pattern as useTheme / useComposer.
// Host installs a real implementation at boot via
// `__installChatNav`; tests can install a stub through the same
// hook.

export interface ChatNavApi {
  /** What the chat area is currently showing. null = webchat. */
  viewingSessionId: string | null;
  /** Pin the chat area to a given session. Pass null to return
   *  to the user's webchat thread. */
  setViewingSession: (sessionId: string | null) => void;
  /** Send a prompt to the agent as if the user typed it, going
   *  through the host's full send path (streaming state, optimistic
   *  echo, retry bookkeeping). Used by composer-action buttons that
   *  kick off a preset instruction (e.g. the wiki "record" button).
   *  Optional for backwards-compat with older hosts. */
  sendPrompt?: (content: string) => void;
}

interface ChatNavGlobalSlot {
  __tianshuPluginSdkChatNavHook__?: () => ChatNavApi;
}

function chatNavSlot(): ChatNavGlobalSlot {
  return globalThis as unknown as ChatNavGlobalSlot;
}

export function __installChatNav(fn: () => ChatNavApi): void {
  chatNavSlot().__tianshuPluginSdkChatNavHook__ = fn;
}

export function __resetChatNavForTest(): void {
  delete chatNavSlot().__tianshuPluginSdkChatNavHook__;
}

/** Hook returning the host's current chat-navigation state. */
export function useChatNav(): ChatNavApi {
  const fn = chatNavSlot().__tianshuPluginSdkChatNavHook__;
  if (!fn) {
    return {
      viewingSessionId: null,
      setViewingSession: () => {},
    };
  }
  return fn();
}

// ─── WebSocket event hook ─────────────────────────────────────────────
//
// Plugins occasionally want to react to push-broadcasted events
// the host server emits — e.g. a wechat sidebar section refreshing
// its session list when a new inbound message lands. Subscribing
// from a plugin's own React component without reaching into host
// internals is what this hook provides.
//
// The host installs a singleton subscribe function at boot via
// __installUseWsEvent; plugins call useWsEvent(type, handler) from
// any component. Effect cleanup unsubscribes on unmount.
//
// We deliberately keep this generic over wire-message type so the
// SDK doesn't need to know every event the server emits.

export interface WsEventApi {
  /** Subscribe to a typed server event. Returns the cleanup
   *  function the React effect needs to unsubscribe. Caller
   *  is responsible for stable handler identity (React-shaped). */
  subscribe: (
    type: string,
    handler: (event: { type: string } & Record<string, unknown>) => void,
  ) => () => void;
  /** Send a WS message up to the host. Used by plugins whose panels
   *  need to reply to a server-initiated request (e.g. board_act:
   *  the server broadcasts an op, the panel drives its iframe, then
   *  sends the result back here). Best-effort: queued if the socket
   *  isn't open yet. */
  send?: (msg: { type: string } & Record<string, unknown>) => void;
}

interface WsEventGlobalSlot {
  __tianshuPluginSdkWsEventApi__?: WsEventApi;
}

function wsEventSlot(): WsEventGlobalSlot {
  return globalThis as unknown as WsEventGlobalSlot;
}

export function __installWsEventApi(api: WsEventApi): void {
  wsEventSlot().__tianshuPluginSdkWsEventApi__ = api;
}

export function __resetWsEventApiForTest(): void {
  delete wsEventSlot().__tianshuPluginSdkWsEventApi__;
}

/** Programmatic subscribe — plugins call this from their own
 *  useEffect to receive WebSocket events from the host. Returns the
 *  unsubscribe function (or a no-op when the host hasn't installed
 *  an API yet, e.g. unit tests or pre-mount probing). */
export function subscribeToWsEvent<TEvent extends { type: string }>(
  type: TEvent["type"],
  handler: (event: TEvent) => void,
): () => void {
  const api = wsEventSlot().__tianshuPluginSdkWsEventApi__;
  if (!api) return () => {};
  return api.subscribe(
    type,
    handler as (e: { type: string } & Record<string, unknown>) => void,
  );
}

/** Programmatic send — plugins call this to push a WS message up to
 *  the host (e.g. replying to a server-initiated board_act request).
 *  No-op when the host hasn't installed a WS API yet. */
export function sendWsMessage(
  msg: { type: string } & Record<string, unknown>,
): void {
  const api = wsEventSlot().__tianshuPluginSdkWsEventApi__;
  api?.send?.(msg);
}
