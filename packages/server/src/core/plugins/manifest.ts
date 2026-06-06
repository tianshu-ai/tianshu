// Plugin manifest validation. Hand-written validator over plain JSON
// to keep dependencies small. Mirrors the types declared in
// `@tianshu/plugin-sdk/manifest.ts`.
//
// Throws PluginManifestError with a `pluginId` (when discoverable)
// and a list of accumulated issues so the discovery step can mark
// the manifest as failed instead of crashing the whole boot.

import type {
  ApiRouteContribution,
  AttachmentRendererContribution,
  ComposerActionContribution,
  ContributesV1,
  PluginManifest,
  RightPanelContribution,
  SandboxContribution,
  SkillContribution,
  ToolContribution,
  SidebarSectionContribution,
  TopBarButtonContribution,
  WsMessageContribution,
} from "@tianshu/plugin-sdk";
import { isCapabilityName } from "@tianshu/plugin-sdk";

export class PluginManifestError extends Error {
  readonly code = "PLUGIN_MANIFEST_INVALID" as const;
  constructor(
    public readonly pluginId: string | null,
    public readonly issues: string[],
  ) {
    super(
      `manifest invalid${pluginId ? ` for ${pluginId}` : ""}: ${issues.join("; ")}`,
    );
    this.name = "PluginManifestError";
  }
}

const ID_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(-[\w.-]+)?(\+[\w.-]+)?$/;
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

interface Acc {
  issues: string[];
}

export function parseManifest(raw: unknown): PluginManifest {
  const acc: Acc = { issues: [] };
  if (!isPlainObject(raw)) {
    throw new PluginManifestError(null, ["manifest must be a JSON object"]);
  }

  const id = expectString(raw, "id", acc);
  if (id != null && !ID_RE.test(id)) {
    acc.issues.push(`id "${id}" must match ${ID_RE}`);
  }

  const version = expectString(raw, "version", acc);
  if (version != null && !SEMVER_RE.test(version)) {
    acc.issues.push(`version "${version}" must be semver`);
  }
  const displayName = expectString(raw, "displayName", acc);

  const description = optionalString(raw, "description", acc);
  const author = optionalString(raw, "author", acc);
  const license = optionalString(raw, "license", acc);
  const permissions = optionalStringArray(raw, "permissions", acc);
  const provides = optionalCapabilityArray(raw, "provides", acc);
  const requires = optionalCapabilityArray(raw, "requires", acc);
  const client = optionalEntryRef(raw, "client", acc);
  const server = optionalEntryRef(raw, "server", acc);
  const contributes = optionalContributes(raw.contributes, acc);

  // ADR-0004 §3: every capability listed in `provides[]` must be
  // backed by a real contribution. Today the only derivation rule
  // is sandbox.<kind> ← contributes.sandboxes[].kind. browser.cdp is
  // also accepted as it ships piggy-backed on a sandbox contribution
  // (the BrowserSidecar getter on SandboxRunner). We don't enforce
  // browser.cdp here — the registry sees the runner at activation
  // time and decides; missing the actual sidecar surfaces as a
  // failed activation, not a manifest error.
  if (provides && provides.length > 0) {
    const sandboxKinds = new Set(
      (contributes?.sandboxes ?? []).map((s) => s.kind),
    );
    for (const cap of provides) {
      if (cap.startsWith("sandbox.")) {
        const kind = cap.slice("sandbox.".length);
        if (!sandboxKinds.has(kind as SandboxContribution["kind"])) {
          acc.issues.push(
            `declared provides["${cap}"] without a backing sandboxes[] contribution of kind=${kind}`,
          );
        }
      }
    }
  }

  if (acc.issues.length > 0) {
    throw new PluginManifestError(id ?? null, acc.issues);
  }

  return {
    id: id!,
    version: version!,
    displayName: displayName!,
    description,
    author,
    license,
    permissions,
    provides,
    requires,
    client,
    server,
    contributes,
  };
}

function optionalCapabilityArray(
  raw: Record<string, unknown>,
  key: string,
  acc: Acc,
): string[] | undefined {
  const v = raw[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) {
    acc.issues.push(`${key} must be an array of capability strings`);
    return undefined;
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < v.length; i++) {
    const item = v[i];
    if (typeof item !== "string") {
      acc.issues.push(`${key}[${i}] must be a string`);
      continue;
    }
    if (!isCapabilityName(item)) {
      acc.issues.push(
        `${key}[${i}] "${item}" is not a known capability (see KNOWN_CAPABILITIES in @tianshu/plugin-sdk)`,
      );
      continue;
    }
    if (seen.has(item)) {
      acc.issues.push(`${key}[${i}] "${item}" listed more than once`);
      continue;
    }
    seen.add(item);
    out.push(item);
  }
  return out;
}

function optionalContributes(raw: unknown, acc: Acc): ContributesV1 | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isPlainObject(raw)) {
    acc.issues.push("contributes must be an object");
    return undefined;
  }

  const out: ContributesV1 = {};

  if ("topBarButtons" in raw) {
    out.topBarButtons = parseArray(raw.topBarButtons, "topBarButtons", acc, parseTopBarButton);
  }
  if ("rightPanels" in raw) {
    out.rightPanels = parseArray(raw.rightPanels, "rightPanels", acc, parseRightPanel);
  }
  if ("sidebarSections" in raw) {
    out.sidebarSections = parseArray(
      raw.sidebarSections,
      "sidebarSections",
      acc,
      parseSidebarSection,
    );
  }
  if ("sandboxes" in raw) {
    out.sandboxes = parseArray(raw.sandboxes, "sandboxes", acc, parseSandbox);
  }
  if ("tools" in raw) {
    out.tools = parseArray(raw.tools, "tools", acc, parseTool);
  }
  if ("skills" in raw) {
    out.skills = parseArray(raw.skills, "skills", acc, parseSkill);
  }
  if ("composerActions" in raw) {
    out.composerActions = parseArray(
      raw.composerActions,
      "composerActions",
      acc,
      parseComposerAction,
    );
  }
  if ("attachmentRenderers" in raw) {
    out.attachmentRenderers = parseArray(
      raw.attachmentRenderers,
      "attachmentRenderers",
      acc,
      parseAttachmentRenderer,
    );
  }
  if ("apiRoutes" in raw) {
    out.apiRoutes = parseArray(raw.apiRoutes, "apiRoutes", acc, parseApiRoute);
  }
  if ("wsMessages" in raw) {
    out.wsMessages = parseArray(raw.wsMessages, "wsMessages", acc, parseWsMessage);
  }
  // `commands` slot was declared in ADR-0003 §5 but never wired
  // through to a UI; chore/plugin-sdk-cleanup removed it. If a
  // manifest still carries `commands`, ignore it silently — we
  // don't want to fail-load existing plugins for an obsolete slot.

  return out;
}

function parseTopBarButton(raw: unknown, ctx: string, acc: Acc): TopBarButtonContribution | null {
  if (!isPlainObject(raw)) {
    acc.issues.push(`${ctx} entry must be an object`);
    return null;
  }
  const id = expectString(raw, "id", acc, ctx);
  const icon = expectString(raw, "icon", acc, ctx);
  const tooltip = optionalString(raw, "tooltip", acc, ctx);
  const opensPanel = optionalString(raw, "opensPanel", acc, ctx);
  const order = optionalNumber(raw, "order", acc, ctx);
  if (id == null || icon == null) return null;
  return { id, icon, tooltip, opensPanel, order };
}

function parseRightPanel(raw: unknown, ctx: string, acc: Acc): RightPanelContribution | null {
  if (!isPlainObject(raw)) {
    acc.issues.push(`${ctx} entry must be an object`);
    return null;
  }
  const id = expectString(raw, "id", acc, ctx);
  const displayName = expectString(raw, "displayName", acc, ctx);
  const component = expectString(raw, "component", acc, ctx);
  if (id == null || displayName == null || component == null) return null;
  return { id, displayName, component };
}

const SANDBOX_KINDS = new Set<SandboxContribution["kind"]>(["shell"]);

function parseTool(raw: unknown, ctx: string, acc: Acc): ToolContribution | null {
  if (!isPlainObject(raw)) {
    acc.issues.push(`${ctx} entry must be an object`);
    return null;
  }
  const id = expectString(raw, "id", acc, ctx);
  const moduleKey = expectString(raw, "module", acc, ctx);
  if (id == null || moduleKey == null) return null;
  return { id, module: moduleKey };
}

function parseSkill(raw: unknown, ctx: string, acc: Acc): SkillContribution | null {
  if (!isPlainObject(raw)) {
    acc.issues.push(`${ctx} entry must be an object`);
    return null;
  }
  const id = expectString(raw, "id", acc, ctx);
  const skillPath = expectString(raw, "path", acc, ctx);
  if (id == null || skillPath == null) return null;
  return { id, path: skillPath };
}

function parseSandbox(raw: unknown, ctx: string, acc: Acc): SandboxContribution | null {
  if (!isPlainObject(raw)) {
    acc.issues.push(`${ctx} entry must be an object`);
    return null;
  }
  const id = expectString(raw, "id", acc, ctx);
  const kind = expectString(raw, "kind", acc, ctx);
  const displayName = expectString(raw, "displayName", acc, ctx);
  const moduleKey = expectString(raw, "module", acc, ctx);
  if (kind != null && !SANDBOX_KINDS.has(kind as SandboxContribution["kind"])) {
    acc.issues.push(
      `${ctx}.kind "${kind}" must be one of ${[...SANDBOX_KINDS].join(", ")}`,
    );
    return null;
  }
  if (id == null || kind == null || displayName == null || moduleKey == null) return null;
  return {
    id,
    kind: kind as SandboxContribution["kind"],
    displayName,
    module: moduleKey,
  };
}

function parseComposerAction(
  raw: unknown,
  ctx: string,
  acc: Acc,
): ComposerActionContribution | null {
  if (!isPlainObject(raw)) {
    acc.issues.push(`${ctx} entry must be an object`);
    return null;
  }
  const id = expectString(raw, "id", acc, ctx);
  const component = expectString(raw, "component", acc, ctx);
  const icon = optionalString(raw, "icon", acc, ctx);
  const tooltip = optionalString(raw, "tooltip", acc, ctx);
  const order = optionalNumber(raw, "order", acc, ctx);
  if (id == null || component == null) return null;
  return { id, component, icon, tooltip, order };
}

function parseAttachmentRenderer(
  raw: unknown,
  ctx: string,
  acc: Acc,
): AttachmentRendererContribution | null {
  if (!isPlainObject(raw)) {
    acc.issues.push(`${ctx} entry must be an object`);
    return null;
  }
  const id = expectString(raw, "id", acc, ctx);
  const component = expectString(raw, "component", acc, ctx);
  const mimePattern = expectString(raw, "mimePattern", acc, ctx);
  const order = optionalNumber(raw, "order", acc, ctx);
  if (id == null || component == null || mimePattern == null) return null;
  // Reject anything that's not one of the three supported forms.
  // We validate eagerly so a bad pattern fails fast at boot rather
  // than silently never matching.
  if (!isValidMimePattern(mimePattern)) {
    acc.issues.push(
      `${ctx}.mimePattern "${mimePattern}" must be "<type>/<subtype>", "<type>/*", or "*\u2009/ *"`,
    );
    return null;
  }
  return { id, component, mimePattern, order };
}

function isValidMimePattern(p: string): boolean {
  if (p === "*/*") return true;
  // type/* or type/subtype — simple grammar, no parameters.
  return /^[A-Za-z0-9!#$&^_.+-]+\/(\*|[A-Za-z0-9!#$&^_.+-]+)$/.test(p);
}

function parseSidebarSection(
  raw: unknown,
  ctx: string,
  acc: Acc,
): SidebarSectionContribution | null {
  if (!isPlainObject(raw)) {
    acc.issues.push(`${ctx} entry must be an object`);
    return null;
  }
  const id = expectString(raw, "id", acc, ctx);
  const displayName = expectString(raw, "displayName", acc, ctx);
  const component = expectString(raw, "component", acc, ctx);
  const after = optionalString(raw, "after", acc, ctx);
  const order = optionalNumber(raw, "order", acc, ctx);
  if (id == null || displayName == null || component == null) return null;
  return { id, displayName, component, after, order };
}

function parseApiRoute(raw: unknown, ctx: string, acc: Acc): ApiRouteContribution | null {
  if (!isPlainObject(raw)) {
    acc.issues.push(`${ctx} entry must be an object`);
    return null;
  }
  const method = expectString(raw, "method", acc, ctx);
  const pathStr = expectString(raw, "path", acc, ctx);
  const handler = expectString(raw, "handler", acc, ctx);
  if (method != null && !HTTP_METHODS.has(method)) {
    acc.issues.push(`${ctx}.method "${method}" must be one of ${[...HTTP_METHODS].join(",")}`);
    return null;
  }
  if (pathStr != null && !pathStr.startsWith("/")) {
    acc.issues.push(`${ctx}.path "${pathStr}" must start with "/"`);
    return null;
  }
  if (method == null || pathStr == null || handler == null) return null;
  return {
    method: method as ApiRouteContribution["method"],
    path: pathStr,
    handler,
  };
}

function parseWsMessage(raw: unknown, ctx: string, acc: Acc): WsMessageContribution | null {
  if (!isPlainObject(raw)) {
    acc.issues.push(`${ctx} entry must be an object`);
    return null;
  }
  const type = expectString(raw, "type", acc, ctx);
  const handler = expectString(raw, "handler", acc, ctx);
  if (type == null || handler == null) return null;
  return { type, handler };
}

// ─── tiny helpers ──────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function expectString(
  raw: Record<string, unknown>,
  key: string,
  acc: Acc,
  ctx?: string,
): string | undefined {
  const v = raw[key];
  if (typeof v !== "string" || v.length === 0) {
    acc.issues.push(`${ctx ? `${ctx}.` : ""}${key} must be a non-empty string`);
    return undefined;
  }
  return v;
}

function optionalString(
  raw: Record<string, unknown>,
  key: string,
  acc: Acc,
  ctx?: string,
): string | undefined {
  const v = raw[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") {
    acc.issues.push(`${ctx ? `${ctx}.` : ""}${key} must be a string`);
    return undefined;
  }
  return v;
}

function optionalNumber(
  raw: Record<string, unknown>,
  key: string,
  acc: Acc,
  ctx?: string,
): number | undefined {
  const v = raw[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    acc.issues.push(`${ctx ? `${ctx}.` : ""}${key} must be a finite number`);
    return undefined;
  }
  return v;
}

function optionalStringArray(
  raw: Record<string, unknown>,
  key: string,
  acc: Acc,
): string[] | undefined {
  const v = raw[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    acc.issues.push(`${key} must be an array of strings`);
    return undefined;
  }
  return v as string[];
}

function optionalEntryRef(
  raw: Record<string, unknown>,
  key: string,
  acc: Acc,
): { entry: string } | undefined {
  const v = raw[key];
  if (v === undefined || v === null) return undefined;
  if (!isPlainObject(v)) {
    acc.issues.push(`${key} must be an object`);
    return undefined;
  }
  const entry = expectString(v, "entry", acc, key);
  if (entry == null) return undefined;
  return { entry };
}

function parseArray<T>(
  raw: unknown,
  ctx: string,
  acc: Acc,
  fn: (item: unknown, ctx: string, acc: Acc) => T | null,
): T[] {
  if (!Array.isArray(raw)) {
    acc.issues.push(`${ctx} must be an array`);
    return [];
  }
  const out: T[] = [];
  raw.forEach((item, i) => {
    const parsed = fn(item, `${ctx}[${i}]`, acc);
    if (parsed) out.push(parsed);
  });
  return out;
}
