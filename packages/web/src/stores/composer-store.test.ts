// Composer store unit tests.
//
// Locks the contract that ChatInput depends on: hasPending() gating,
// transform chaining order, and addAttachment id assignment.

import { beforeEach, describe, expect, it } from "vitest";
import {
  getComposerApi,
  useComposerStore,
} from "./composer-store";

beforeEach(() => {
  // Reset store between tests — there's no built-in reset on zustand.
  useComposerStore.setState({
    attachments: [],
    transforms: [],
    _nextId: 1,
  });
});

describe("composer store: attachments", () => {
  it("addAttachment assigns a stable id and appends to the list", () => {
    const id1 = useComposerStore.getState().addAttachment({
      name: "a.txt",
      size: 10,
      status: "uploading",
    });
    const id2 = useComposerStore.getState().addAttachment({
      name: "b.txt",
      size: 20,
      status: "uploading",
    });
    expect(id1).not.toBe(id2);
    const list = useComposerStore.getState().attachments;
    expect(list.map((a) => a.name)).toEqual(["a.txt", "b.txt"]);
    expect(list.map((a) => a.id)).toEqual([id1, id2]);
  });

  it("updateAttachment patches in place", () => {
    const id = useComposerStore.getState().addAttachment({
      name: "a.txt",
      size: 10,
      status: "uploading",
    });
    useComposerStore.getState().updateAttachment(id, {
      status: "ready",
      path: "/uploads/a.txt",
    });
    const a = useComposerStore.getState().attachments[0]!;
    expect(a.status).toBe("ready");
    expect(a.path).toBe("/uploads/a.txt");
    expect(a.name).toBe("a.txt"); // untouched
  });

  it("removeAttachment drops by id", () => {
    const a = useComposerStore.getState().addAttachment({
      name: "a.txt",
      size: 1,
      status: "ready",
    });
    const b = useComposerStore.getState().addAttachment({
      name: "b.txt",
      size: 1,
      status: "ready",
    });
    useComposerStore.getState().removeAttachment(a);
    const ids = useComposerStore.getState().attachments.map((x) => x.id);
    expect(ids).toEqual([b]);
  });

  it("hasPending() is true iff any attachment is uploading", () => {
    const id = useComposerStore.getState().addAttachment({
      name: "a.txt",
      size: 1,
      status: "uploading",
    });
    expect(useComposerStore.getState().hasPending()).toBe(true);
    useComposerStore.getState().updateAttachment(id, { status: "ready" });
    expect(useComposerStore.getState().hasPending()).toBe(false);
    useComposerStore.getState().addAttachment({
      name: "b.txt",
      size: 1,
      status: "error",
      error: "x",
    });
    expect(useComposerStore.getState().hasPending()).toBe(false);
  });
});

describe("composer store: transforms", () => {
  it("registerDraftTransform runs in registration order", async () => {
    useComposerStore.getState().registerDraftTransform((t) => t + " A");
    useComposerStore.getState().registerDraftTransform((t) => t + " B");
    const out = await useComposerStore.getState().applyTransforms("hi");
    expect(out).toBe("hi A B");
  });

  it("returned unregister fn removes a transform", async () => {
    const off = useComposerStore
      .getState()
      .registerDraftTransform((t) => t + " A");
    off();
    const out = await useComposerStore.getState().applyTransforms("hi");
    expect(out).toBe("hi");
  });

  it("only ready attachments reach transforms", async () => {
    useComposerStore.getState().addAttachment({
      name: "ok.txt",
      size: 1,
      status: "ready",
      path: "/uploads/ok.txt",
    });
    useComposerStore.getState().addAttachment({
      name: "bad.txt",
      size: 1,
      status: "error",
      error: "x",
    });
    let received = 0;
    useComposerStore.getState().registerDraftTransform((text, atts) => {
      received = atts.length;
      return text;
    });
    await useComposerStore.getState().applyTransforms("hi");
    expect(received).toBe(1);
  });
});

describe("getComposerApi()", () => {
  it("exposes a stable shape backed by the live store", () => {
    const api = getComposerApi();
    api.addAttachment({ name: "x.txt", size: 1, status: "ready" });
    expect(api.attachments).toHaveLength(1);
    expect(useComposerStore.getState().attachments).toHaveLength(1);
  });
});
