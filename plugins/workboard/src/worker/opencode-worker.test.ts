import { describe, it, expect } from "vitest";
import {
  parseOpencodeEvents,
  resolveTaskModel,
  providerNpmForApi,
} from "./opencode-worker.js";
import type { Task } from "../db/tasks.js";

function fakeTask(labels: string[] = []): Task {
  return {
    id: "t1",
    projectSlug: "inbox",
    ownerUserId: "u1",
    workerRole: null,
    workerAgentId: null,
    title: "do a thing",
    description: null,
    status: "ready",
    priority: 0,
    resultSummary: null,
    resultFiles: [],
    sessionId: null,
    dependsOn: [],
    failureReason: null,
    attempts: 0,
    labels,
  } as unknown as Task;
}

describe("providerNpmForApi", () => {
  it("maps each protocol to the right AI SDK package", () => {
    expect(providerNpmForApi("anthropic-messages")).toBe("@ai-sdk/anthropic");
    expect(providerNpmForApi("google-generative-ai")).toBe("@ai-sdk/google");
    expect(providerNpmForApi("openai-completions")).toBe(
      "@ai-sdk/openai-compatible",
    );
    expect(providerNpmForApi("anything-else")).toBe("@ai-sdk/openai-compatible");
  });
});

describe("resolveTaskModel", () => {
  it("uses the worker default when no label override", () => {
    expect(resolveTaskModel(fakeTask(), "anthropic/claude-opus-4-7")).toBe(
      "anthropic/claude-opus-4-7",
    );
  });
  it("honours a per-task opencode-model: label override", () => {
    const t = fakeTask(["opencode-model:openai/gpt-4o"]);
    expect(resolveTaskModel(t, "anthropic/claude-opus-4-7")).toBe(
      "openai/gpt-4o",
    );
  });
  it("ignores an empty override label", () => {
    const t = fakeTask(["opencode-model:"]);
    expect(resolveTaskModel(t, "anthropic/claude-opus-4-7")).toBe(
      "anthropic/claude-opus-4-7",
    );
  });
});

describe("parseOpencodeEvents", () => {
  it("collects assistant text parts", () => {
    const ndjson = [
      JSON.stringify({ type: "step_start", part: {} }),
      JSON.stringify({ type: "text", part: { text: "Hello " } }),
      JSON.stringify({ type: "tool_use", part: { tool: "bash" } }),
      JSON.stringify({ type: "text", part: { text: "world." } }),
      JSON.stringify({ type: "step_finish", part: {} }),
    ].join("\n");
    const r = parseOpencodeEvents(ndjson);
    expect(r.error).toBeUndefined();
    expect(r.text).toBe("Hello\n\nworld.");
  });

  it("surfaces the first session error", () => {
    const ndjson = [
      JSON.stringify({ type: "text", part: { text: "partial" } }),
      JSON.stringify({
        type: "session.error",
        properties: { error: { message: "rate limited" } },
      }),
    ].join("\n");
    const r = parseOpencodeEvents(ndjson);
    expect(r.error).toContain("rate limited");
    expect(r.text).toBe("partial");
  });

  it("extracts statusCode + message + body from an APIError (the E2E case)", () => {
    const ndjson = JSON.stringify({
      type: "error",
      error: {
        name: "APIError",
        data: {
          message: "Not Found",
          statusCode: 404,
          responseBody: "<html>Cannot POST /messages</html>",
        },
      },
    });
    const r = parseOpencodeEvents(ndjson);
    expect(r.error).toContain("APIError");
    expect(r.error).toContain("status 404");
    expect(r.error).toContain("Not Found");
    expect(r.error).toContain("Cannot POST /messages");
  });

  it("ignores non-JSON / blank lines", () => {
    const ndjson = [
      "",
      "not json",
      "  ",
      JSON.stringify({ type: "text", part: { text: "ok" } }),
    ].join("\n");
    const r = parseOpencodeEvents(ndjson);
    expect(r.text).toBe("ok");
    expect(r.error).toBeUndefined();
  });

  it("empty stream yields empty text, no error", () => {
    const r = parseOpencodeEvents("");
    expect(r.text).toBe("");
    expect(r.error).toBeUndefined();
    expect(r.tools).toEqual([]);
  });

  it("collects tool_use events with args from state.input", () => {
    const ndjson = [
      // opencode's real shape: args under part.state.input
      JSON.stringify({ type: "tool_use", part: { tool: "bash", state: { input: { command: "ls -la" } } } }),
      JSON.stringify({ type: "tool", part: { tool: "write", state: { input: { filePath: "hello.sh" } } } }),
      JSON.stringify({ type: "text", part: { text: "done" } }),
    ].join("\n");
    const r = parseOpencodeEvents(ndjson);
    expect(r.tools.map((t) => t.tool)).toEqual(["bash", "write"]);
    expect(r.tools[0].detail).toContain("ls -la");
    expect((r.tools[0].input as { command?: string }).command).toBe("ls -la");
    expect((r.tools[1].input as { filePath?: string }).filePath).toBe("hello.sh");
    expect(r.text).toBe("done");
  });

  it("merges an arg-less tool_use dup into the completed one", () => {
    const ndjson = [
      JSON.stringify({ type: "tool", part: { tool: "bash", state: {} } }),
      JSON.stringify({ type: "tool", part: { tool: "bash", state: { input: { command: "pytest" } } } }),
    ].join("\n");
    const r = parseOpencodeEvents(ndjson);
    expect(r.tools.length).toBe(1);
    expect((r.tools[0].input as { command?: string }).command).toBe("pytest");
  });
});
