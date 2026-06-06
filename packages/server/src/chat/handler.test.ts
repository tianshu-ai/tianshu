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
  it("default prompt no longer hard-codes file tool names", () => {
    const out = defaultSystemPrompt(fakeCtx(), "alice");
    for (const t of ["list_dir", "read_file", "write_file", "edit_file", "glob"]) {
      expect(out).not.toContain(t);
    }
  });
});
