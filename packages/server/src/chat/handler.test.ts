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

  it("documents the four user-home directories", () => {
    const out = defaultSystemPrompt(fakeCtx(), "alice");
    expect(out).toMatch(/\.\/projects\/<slug>\//);
    expect(out).toMatch(/\.\/uploads\//);
    expect(out).toMatch(/\.\/tmp\//);
    expect(out).toMatch(/\.\/trash\//);
    expect(out).toMatch(/\.\/USER\.md/);
  });

  it("reminds the agent deliverables go to projects, not the home root", () => {
    const out = defaultSystemPrompt(fakeCtx(), "alice");
    expect(out).toMatch(
      /Deliverables go to \.\/projects\/<slug>\/, never the home root\./,
    );
  });

  it("forbids reaching other users' homes", () => {
    const out = defaultSystemPrompt(fakeCtx(), "alice");
    expect(out).toMatch(/Other users' homes in this tenant are off-limits/);
  });

  it("does not leak worker / task vocabulary (not shipped yet)", () => {
    const out = defaultSystemPrompt(fakeCtx(), "alice");
    // The prompt must not invite the model to invent a worker/task UX
    // before ADR-0002 implementation lands.
    expect(out.toLowerCase()).not.toContain("worker");
    expect(out.toLowerCase()).not.toContain("task ");
    expect(out.toLowerCase()).not.toContain("kanban");
  });

  // ADR-0004 N+4: tool-specific guidance now lives in skill markdown
  // files (host-shipped or plugin-contributed), not the system prompt.
  // Default prompt stays plugin-agnostic.
  it("default prompt carries tool guidelines for the writer + sandbox tools", () => {
    // The old assertion ("prompt doesn't mention any tool name")
    // was right for the era when the prompt was meant to be
    // tool-agnostic and every plugin contributed its own
    // discovery block. After we observed Yu's agents looping on
    // truncation / re-installing chromium / starting servers in
    // the foreground, OpenClaw's pattern won out: short, named,
    // imperative "tool guidelines" up front in the system prompt
    // are the single most-effective behaviour nudge we have.
    // The trade-off is the prompt now mentions specific tools by
    // name, which is fine — these tools are part of the host
    // contract, not arbitrary plugin contributions.
    const out = defaultSystemPrompt(fakeCtx(), "alice");
    expect(out).toContain("## Tool guidelines");
    // Writer hints
    expect(out).toContain("write_file");
    expect(out).toContain("edit_file");
    expect(out).toMatch(/skeleton/i);
    expect(out).toMatch(/edits\[\]/);
    // Sandbox hints
    expect(out).toContain("exec");
    expect(out).toMatch(/nohup/);
  });
  it("default prompt warns about installing duplicates of pre-shipped tools", () => {
    const out = defaultSystemPrompt(fakeCtx(), "alice");
    // From the same skill family Yu hit at runtime: agents
    // reflexively reinstalling chromium / libreoffice burns
    // sandbox time and survives no resets. Keep the warning in
    // the prompt so it shows up to the main agent too (its
    // worker-scope skill is invisible in main scope).
    expect(out).toMatch(/playwright install/);
    expect(out).toMatch(/already ships/);
  });
});
