// Unit tests for defaultSystemPrompt — the workspace scaffold that the
// agent sees on every conversation.
//
// We don't try to run the full chat handler here (that needs a live
// model + WebSocket); we just lock down the prompt shape because it's
// the "mindset injection" defined in ADR-0001 §3 and the contract
// every future PR will lean on.

import { describe, it, expect } from "vitest";
import {
  defaultSystemPrompt,
  substituteUserIdPlaceholders,
} from "./handler.js";
import type { TenantContext } from "../core/index.js";

function fakeCtx(over: Partial<TenantContext> = {}): TenantContext {
  return {
    tenantId: "acme",
    config: { branding: { name: "Tianshu" } },
    // defaultSystemPrompt now consults two paths to inject context
    // files: workspaceDir/_tenant for tenant-shared SOUL/AGENTS/
    // MEMORY, and userHomeDir for per-user USER.md. Tests don't
    // exercise that path by default (obviously-fake paths) —
    // readWorkspaceFile catches ENOENT and emits nothing.
    workspaceDir: "/nonexistent-test-workspace",
    userHomeDir: () => "/nonexistent-test-home",
    ...over,
  } as unknown as TenantContext;
}

describe("defaultSystemPrompt", () => {
  it("identifies the brand, tenant, and user", () => {
    const out = defaultSystemPrompt(fakeCtx(), "alice");
    expect(out).toContain("You are Tianshu");
    // Tenant + user now live in the Runtime Context block,
    // wrapped in backticks instead of the legacy quoted form.
    // The block also carries time + host so the LLM can answer
    // "what day is it?" / "am I on macOS?" without a tool call.
    expect(out).toContain("Runtime Context");
    expect(out).toMatch(/Tenant:\s*`acme`/);
    expect(out).toMatch(/User:\s*`alice`/);
  });

  it("runtime-context block carries an ISO timestamp + timezone", () => {
    // Specific format guarantees the LLM can parse without
    // ambiguity: YYYY-MM-DDTHH:MM:SS±HH:MM. Don't pin the
    // exact instant — just the shape.
    const out = defaultSystemPrompt(fakeCtx(), "alice");
    expect(out).toMatch(
      /Time:\s*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/,
    );
    expect(out).toMatch(/timezone\s+\S+/);
  });

  it("runtime-context block carries host platform + Node version", () => {
    // Lets the model branch on macOS-vs-Linux shell flags etc.
    // without a probe. The line shape is
    //   Host: <platform> <arch> · Node <version>
    const out = defaultSystemPrompt(fakeCtx(), "alice");
    expect(out).toMatch(/Host:\s+\S+\s+\S+/);
    expect(out).toMatch(/Node\s+\d+\.\d+/);
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
  it("default prompt does NOT hardcode plugin-shipped tool guidance (skeleton, edits[], nohup, ...)", () => {
    const out = defaultSystemPrompt(fakeCtx(), "alice");
    expect(out).not.toContain("## Tool guidelines");
    // The previously-hardcoded plugin guidance language must not
    // come back as host text. write_file / edit_file are tolerated
    // here because the User Profile block names them as the canonical
    // way to persist USER.md (the file is per-user identity, not a
    // plugin convention) — but no other tool guidance should leak.
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

  // Execution Bias is host-hardcoded behaviour guidance — it must
  // appear regardless of which plugins are loaded so the rules
  // ("act in this turn", "don't finish with a plan", etc) shape
  // every agent run, not just ones with a particular plugin set.
  it("includes the host-level Execution Bias block", () => {
    const out = defaultSystemPrompt(fakeCtx(), "alice");
    expect(out).toContain("## Execution Bias");
    expect(out).toContain("act in this turn");
    expect(out).toContain("do not finish with a plan/promise");
  });

  it("injects tenant context files (_tenant/AGENTS, SOUL, MEMORY) plus per-user USER.md", () => {
    // Real fs round-trip: write the files under a temp workspace
    // matching the real layout and check the rendered prompt
    // picks them up.
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const os = require("node:os") as typeof import("node:os");
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-ws-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-home-"));
    fs.mkdirSync(path.join(ws, "_tenant"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, "_tenant", "AGENTS.md"),
      "team agreement: only commit on weekdays",
    );
    fs.writeFileSync(
      path.join(ws, "_tenant", "MEMORY.md"),
      "long-term note about project alpha",
    );
    fs.writeFileSync(path.join(home, "USER.md"), "prefers terse replies");
    // SOUL.md missing on purpose: every file is independently optional.
    const out = defaultSystemPrompt(
      fakeCtx({
        workspaceDir: ws,
        userHomeDir: () => home,
      } as never),
      "alice",
    );
    expect(out).toContain("## Workspace Context");
    expect(out).toContain("### _tenant/AGENTS.md");
    expect(out).toContain("only commit on weekdays");
    expect(out).toContain("### _tenant/MEMORY.md");
    expect(out).toContain("long-term note about project alpha");
    // <self> placeholder is substituted with the caller's userId.
    expect(out).toContain("### users/alice/USER.md");
    expect(out).not.toContain("<self>");
    expect(out).toContain("prefers terse replies");
    // Missing SOUL.md never appears as an empty section.
    expect(out).not.toContain("### _tenant/SOUL.md");
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("omits the workspace context block when none of the files exist", () => {
    const out = defaultSystemPrompt(fakeCtx(), "alice");
    expect(out).not.toContain("## Workspace Context");
  });

  it("substitutes <self> and <userId> placeholders with the caller's actual userId", () => {
    // We don't materialise any context files, but the prompt
    // body itself contains `users/<self>/USER.md` references
    // (User Profile block, etc). The substitution pass at the
    // end of defaultSystemPrompt should turn those into
    // `users/dev/USER.md` so the LLM never has to guess what
    // the placeholder resolves to.
    const out = defaultSystemPrompt(fakeCtx(), "dev");
    expect(out).not.toContain("<self>");
    expect(out).not.toContain("<userId>");
    expect(out).toContain("users/dev/USER.md");
  });

  it("includes the User Profile prompt with both populated and scaffold guidance", () => {
    // The prompt is uniform regardless of whether USER.md exists —
    // the LLM judges populated-vs-scaffold from the Workspace
    // Context block. So the host text always carries both branches.
    const out = defaultSystemPrompt(fakeCtx(), "alice");
    expect(out).toContain("## User Profile (USER.md)");
    // Cold-start / scaffold branch language present.
    expect(out).toMatch(/scaffold/i);
    expect(out).toContain("write_file");
    // Maintenance branch language present.
    expect(out).toContain("edit_file");
    expect(out).toMatch(/keep it accurate/i);
  });

  it("surfaces an existing USER.md via the Workspace Context block (LLM judges populated-vs-scaffold)", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const os = require("node:os") as typeof import("node:os");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-userprof-"));
    fs.writeFileSync(
      path.join(home, "USER.md"),
      "# About me\nName: Alice\nTimezone: UTC+8\n",
    );
    const out = defaultSystemPrompt(
      fakeCtx({ userHomeDir: () => home } as never),
      "alice",
    );
    expect(out).toContain("## Workspace Context");
    // <self> placeholder is substituted with the caller's userId.
    expect(out).toContain("### users/alice/USER.md");
    expect(out).not.toContain("<self>");
    expect(out).toContain("Name: Alice");
    expect(out).toContain("## User Profile (USER.md)");
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("truncates very large workspace files with a head + tail snippet", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const os = require("node:os") as typeof import("node:os");
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-ws-big-"));
    fs.mkdirSync(path.join(ws, "_tenant"), { recursive: true });
    // 20 KB — well over the 6 KB full-cap, triggers head/tail.
    const big = "HEAD-MARK\n" + "x".repeat(20_000) + "\nTAIL-MARK";
    fs.writeFileSync(path.join(ws, "_tenant", "AGENTS.md"), big);
    const out = defaultSystemPrompt(
      fakeCtx({ workspaceDir: ws } as never),
      "alice",
    );
    expect(out).toContain("HEAD-MARK");
    expect(out).toContain("TAIL-MARK");
    expect(out).toContain("truncated");
    fs.rmSync(ws, { recursive: true, force: true });
  });
});

describe("substituteUserIdPlaceholders", () => {
  it("replaces <self> and <userId> globally with the userId", () => {
    const before =
      "see /workspace/users/<self>/foo.py and users/<userId>/USER.md";
    const after = substituteUserIdPlaceholders(before, "dev");
    expect(after).toBe(
      "see /workspace/users/dev/foo.py and users/dev/USER.md",
    );
  });

  it("is a no-op on prompts without placeholders", () => {
    const text = "plain prompt without templates";
    expect(substituteUserIdPlaceholders(text, "dev")).toBe(text);
  });

  it("is idempotent", () => {
    const before = "users/<self>/USER.md";
    const once = substituteUserIdPlaceholders(before, "dev");
    const twice = substituteUserIdPlaceholders(once, "dev");
    expect(twice).toBe(once);
    expect(twice).toBe("users/dev/USER.md");
  });

  it("returns the prompt unchanged when userId is empty", () => {
    const text = "users/<self>/USER.md";
    expect(substituteUserIdPlaceholders(text, "")).toBe(text);
  });
});
