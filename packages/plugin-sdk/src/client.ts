// Client-side plugin authoring types. Imported as
// `@tianshu/plugin-sdk/client`.
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
 * `useComposer()` from `@tianshu/plugin-sdk/client` from inside a
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
    >
  >;
}

// `useComposer` is implemented by the host (web bundle) and re-exported
// here as a typed declaration so plugin authors `import { useComposer }
// from "@tianshu/plugin-sdk/client"`. The host swaps the implementation
// in via __installUseComposer().
//
// The accessor lives on `globalThis` instead of a module-local
// `let` so that plugin packages with a transitively-duplicated SDK
// copy still see the host's installed implementation. If the host
// installed first into globalThis, *any* import of @tianshu/plugin-sdk/client
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
