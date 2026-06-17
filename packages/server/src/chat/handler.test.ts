// Unit tests for defaultSystemPrompt — the workspace scaffold that the
// agent sees on every conversation.
//
// We don't try to run the full chat handler here (that needs a live
// model + WebSocket); we just lock down the prompt shape because it's
// the "mindset injection" defined in ADR-0001 §3 and the contract
// every future PR will lean on.

import { describe, it, expect } from "vitest";
import { defaultSystemPrompt } from "./handler.js";
import type { TenantContext } from "../core/index.js";

function fakeCtx(over: Partial<TenantContext> = {}): TenantContext {
  return {
    tenantId: "acme",
    config: { branding: { name: "Tianshu" } },
    ...over,
  } as unknown as TenantContext;
}

describe("defaultSystemPrompt", () => {
  it("identifies the brand, tenant, and user", () => {
    const out = defaultSystemPrompt(fakeCtx(), "alice");
    expect(out).toContain("You are Tianshu");
    expect(out).toContain('Tenant: "acme"');
    expect(out).toContain('User: "alice"');
  });

  it("respects branding.name override", () => {
    const ctx = fakeCtx({
      config: { branding: { name: "Acme Helper" } },
    } as Partial<TenantContext>);
    const out = defaultSystemPrompt(ctx, "alice");
    expect(out).toContain("You are Acme Helper");
  });

  // ADR-0006 follow-up: the workspace layout / conventions /
  // file-reference rules used to be host-hardcoded in this prompt.
  // They now belong to the `files` plugin's
  // `manifest.contributes.systemPromptFragments` and reach the
  // prompt via the same `formatPluginPromptFragments(...)` path
  // every other plugin uses. With no plugin fragments injected
  // (fakeCtx has none), the layout text must NOT appear in the
  // default host prompt.
  it("layout text is plugin-contributed, not host-hardcoded", () => {
    const out = defaultSystemPrompt(fakeCtx(), "alice");
    expect(out).not.toContain("WORKSPACE LAYOUT");
    expect(out).not.toMatch(/\.\/projects\/<slug>\//);
    expect(out).not.toMatch(/\.\/uploads\//);
    expect(out).not.toMatch(/Personal directories/);
    expect(out).not.toMatch(/Deliverables go to/);
    expect(out).not.toMatch(/Other users' homes/);
  });

  it("layout reaches the prompt when files plugin contributes its fragment", () => {
    const out = defaultSystemPrompt(
      fakeCtx(),
      "alice",
      [],
      [
        {
          pluginId: "files",
          pluginDisplayName: "Workspace Files",
          fragmentId: "workspace-layout",
          text:
            "WORKSPACE LAYOUT\nYour default working directory is the user's private home in this tenant.\n\nPersonal directories (use freely):\n  ./projects/<slug>/   active work; reports, code, deliverables go here.\n  ./uploads/           files the user uploaded for you to look at.\n  ./tmp/               scratch space; clean up after yourself.\n  ./trash/             soft-delete; move things here instead of removing them.\n  ./USER.md            personal preferences (read on demand).",
        },
      ],
    );
    expect(out).toContain("WORKSPACE LAYOUT");
    expect(out).toMatch(/\.\/projects\/<slug>\//);
    expect(out).toMatch(/\.\/uploads\//);
    expect(out).toMatch(/\.\/tmp\//);
    expect(out).toMatch(/\.\/trash\//);
    expect(out).toMatch(/\.\/USER\.md/);
  });

  it("does not leak worker / task vocabulary (not shipped yet)", () => {
    const out = defaultSystemPrompt(fakeCtx(), "alice");
    // The prompt must not invite the model to invent a worker/task UX
    // before ADR-0002 implementation lands.
    expect(out.toLowerCase()).not.toContain("worker");
    expect(out.toLowerCase()).not.toContain("task ");
    expect(out.toLowerCase()).not.toContain("kanban");
  });

  // ADR-0006: tool-specific guidance now lives on the contributing
  // plugin (`manifest.contributes.systemPromptFragments`) and reaches
  // the prompt via `formatPluginPromptFragments(pluginFragments)`.
  // The host-side `defaultSystemPrompt` stays plugin-agnostic; with
  // no plugins active (fakeCtx has none) it must not mention
  // plugin-shipped tool names.
  it("default prompt does NOT hardcode plugin-shipped tool names", () => {
    const out = defaultSystemPrompt(fakeCtx(), "alice");
    expect(out).not.toContain("## Tool guidelines");
    // None of the previously-hardcoded plugin tool names should
    // appear without the plugin contributing them.
    expect(out).not.toContain("write_file");
    expect(out).not.toContain("edit_file");
    expect(out).not.toMatch(/skeleton/i);
    expect(out).not.toMatch(/edits\[\]/);
    expect(out).not.toMatch(/nohup/);
    // microsandbox-specific runtime list is gone too — the
    // microsandbox manifest re-introduces it as a fragment.
    expect(out).not.toMatch(/playwright install/);
    expect(out).not.toMatch(/already ships/);
  });

  it("includes plugin-contributed fragments under their displayName header", () => {
    const out = defaultSystemPrompt(fakeCtx(), "alice", [], [
      {
        pluginId: "files",
        pluginDisplayName: "Workspace Files",
        fragmentId: "edit-rules",
        text: "- Use `edit_file` for in-place changes; `write_file` for new files.",
      },
    ]);
    expect(out).toContain("## Workspace Files");
    expect(out).toContain("edit_file");
  });
});
