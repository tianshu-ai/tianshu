import { afterEach, describe, expect, it } from "vitest";
import {
  __installUseComposer,
  __resetUseComposerForTest,
  useComposer,
  type ComposerApi,
} from "./client.js";

const fakeApi: ComposerApi = {
  attachments: [],
  addAttachment: () => "id",
  updateAttachment: () => undefined,
  removeAttachment: () => undefined,
  registerDraftTransform: () => () => undefined,
};

describe("useComposer / __installUseComposer", () => {
  afterEach(() => {
    __resetUseComposerForTest();
  });

  it("throws when no host has installed the accessor", () => {
    expect(() => useComposer()).toThrow(/without a host/);
  });

  it("returns the installed ComposerApi", () => {
    __installUseComposer(() => fakeApi);
    expect(useComposer()).toBe(fakeApi);
  });

  it("the slot lives on globalThis so module duplication still resolves", () => {
    __installUseComposer(() => fakeApi);
    // Simulate a transitively duplicated copy of the SDK by reading
    // globalThis directly \u2014 same key the second copy would use.
    const slot = globalThis as unknown as {
      __tianshuPluginSdkComposer__?: () => ComposerApi;
    };
    expect(slot.__tianshuPluginSdkComposer__).toBeDefined();
    expect(slot.__tianshuPluginSdkComposer__!()).toBe(fakeApi);
  });

  it("__resetUseComposerForTest clears the accessor", () => {
    __installUseComposer(() => fakeApi);
    __resetUseComposerForTest();
    expect(() => useComposer()).toThrow(/without a host/);
  });
});
