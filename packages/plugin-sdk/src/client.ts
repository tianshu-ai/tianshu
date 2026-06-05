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
  /** 0..1, optional progress for the chip. */
  progress?: number;
  /** Set when status === "error". */
  error?: string;
  /** Plugin-defined metadata (mime type, dimensions, anything). */
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

export interface PluginClientExports {
  components: Record<
    string,
    ComponentType<PanelProps | SidebarSectionProps | ComposerActionProps>
  >;
}

// `useComposer` is implemented by the host (web bundle) and re-exported
// here as a typed declaration so plugin authors `import { useComposer }
// from "@tianshu/plugin-sdk/client"`. The host swaps the implementation
// in via module-augmentation at runtime; in tests the SDK's own copy
// throws to surface "this hook needs a host" mistakes early.
//
// We do not declare this with `declare const`/`declare function`
// because plugin packages may be transitively duplicated in tests; a
// real (throwing) export keeps the import resolvable everywhere.

let composerAccessor: (() => ComposerApi) | null = null;

/** Host-only: install the live `useComposer` accessor. The web bundle
 *  calls this once on bootstrap with a function that reads from its
 *  React context. */
export function __installUseComposer(fn: () => ComposerApi): void {
  composerAccessor = fn;
}

export function useComposer(): ComposerApi {
  if (!composerAccessor) {
    throw new Error(
      "useComposer() called without a host: plugin SDK has no live ComposerApi. " +
        "If you are seeing this in a test, install one with __installUseComposer().",
    );
  }
  return composerAccessor();
}
