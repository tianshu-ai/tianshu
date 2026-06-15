// Per-plugin config form.
//
// Renders a user-editable form for `manifest.configSchema`. Submits
// via PATCH /api/plugins/:id with `{ config: ... }`. The server
// invalidates + re-activates the plugin so the new config takes
// effect on the very next request — no manual restart.
//
// The form lives in two callsites today:
//   - `/admin/core/plugins` admin page (one section per plugin)
//   - (future) per-plugin admin pages can reuse this for their own
//     settings UI by importing the same component.
//
// The PluginManager modal intentionally does NOT include this form;
// per Yu, plugin config belongs in Settings, not in the
// enable/disable list.
//
// Field path semantics: `key` is dotted ("echo.enabled"). We splice
// the form value into a fresh nested object on submit so the
// persisted shape matches what `PluginContext.pluginConfig` sees.

import { useEffect, useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import {
  api,
  type PluginConfigField,
  type PluginConfigFieldGroup,
  type PluginListEntry,
} from "../lib/api";
import { usePluginStore } from "../stores/plugin-store";

export function PluginConfigForm({ plugin }: { plugin: PluginListEntry }) {
  const setPlugins = usePluginStore((s) => s.setPlugins);
  const fields = plugin.configSchema?.fields ?? [];

  const [values, setValues] = useState<Record<string, unknown>>(() =>
    initialValues(fields, plugin.config),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Re-sync if the parent reloaded with a fresh manifest/value pair
  // (e.g. another tab toggled the plugin or saved different config).
  useEffect(() => {
    setValues(initialValues(fields, plugin.config));
    setSavedAt(null);
  }, [plugin.id, plugin.version, plugin.config]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = !shallowEqualValues(
    values,
    initialValues(fields, plugin.config),
  );

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const nested = nestValuesByDottedKey(values);
      const r = await api.setPluginConfig(plugin.id, nested);
      setPlugins(r.plugins);
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setValues(initialValues(fields, plugin.config));
    setError(null);
    setSavedAt(null);
  }

  if (fields.length === 0) {
    return (
      <p className="text-[12px] text-gray-500">
        This plugin has no user-editable configuration.
      </p>
    );
  }

  // Group fields by `field.group?.id`. Order is determined by the
  // first occurrence of each group in the schema, with ungrouped
  // fields keeping their schema-relative position. We render each
  // group as a bordered card; ungrouped fields render flat so
  // single-knob plugins keep their original look.
  const blocks = groupFields(fields);

  return (
    <div className="space-y-5">
      <div className="space-y-5">
        {blocks.map((block, i) => {
          if (block.kind === "field") {
            return (
              <ConfigFieldRow
                key={`f:${i}:${block.field.key}`}
                field={block.field}
                value={values[block.field.key]}
                onChange={(v) =>
                  setValues((prev) => ({ ...prev, [block.field.key]: v }))
                }
              />
            );
          }
          // Group: if the first field is a boolean, hoist it into
          // the header as an inline toggle. This matches the
          // "<Section> [on/off]" pattern that's common for
          // runtime-style settings ("WORKER TYPE  echo  [●]") and
          // saves a redundant "Enabled" row underneath the title.
          const [firstField, ...restFields] = block.fields;
          const headerToggle =
            firstField && firstField.kind === "boolean"
              ? {
                  field: firstField,
                  value: values[firstField.key] === true,
                  onChange: (v: boolean) =>
                    setValues((prev) => ({ ...prev, [firstField.key]: v })),
                }
              : null;
          const renderedFields = headerToggle ? restFields : block.fields;
          return (
            <ConfigGroupCard
              key={`g:${block.group.id}`}
              group={block.group}
              headerToggle={headerToggle}
            >
              {renderedFields.map((f) => (
                <ConfigFieldRow
                  key={f.key}
                  field={f}
                  value={values[f.key]}
                  onChange={(v) =>
                    setValues((prev) => ({ ...prev, [f.key]: v }))
                  }
                />
              ))}
            </ConfigGroupCard>
          );
        })}
      </div>
      {error && (
        <div className="rounded-md border border-rose-700/50 bg-rose-950/40 px-3 py-2 text-[12px] text-rose-300">
          {error}
        </div>
      )}
      <div className="flex items-center gap-2 border-t border-gray-800 pt-3">
        {savedAt && !dirty && (
          <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400">
            <CheckCircle2 size={12} /> Saved
          </span>
        )}
        <button
          type="button"
          onClick={reset}
          disabled={!dirty || busy}
          className="ml-auto inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-gray-700 px-3 py-1.5 text-[12px] text-gray-300 hover:bg-gray-800/50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Reset
        </button>
        <button
          type="button"
          onClick={save}
          disabled={!dirty || busy}
          className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md bg-brand-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? <Loader2 className="inline h-3 w-3 animate-spin" /> : "Save"}
        </button>
      </div>
    </div>
  );
}

const INPUT_BASE =
  "w-full rounded-md border border-gray-700 bg-gray-900 px-3 py-1.5 text-[12px] text-gray-100 outline-none placeholder:text-gray-600 focus:border-brand-500";

/** Pill-style toggle, visually identical to the one in PluginManager
 *  so enable/disable and individual config booleans share the same
 *  affordance. */
function ConfigToggle({
  active,
  onClick,
  ariaLabel,
}: {
  active: boolean;
  onClick: () => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={active}
      aria-label={ariaLabel}
      onClick={onClick}
      className={[
        "relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer items-center rounded-full transition-colors",
        active ? "bg-brand-600" : "bg-gray-700",
      ].join(" ")}
    >
      <span
        className={[
          "inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform",
          active ? "translate-x-5" : "translate-x-1",
        ].join(" ")}
      />
    </button>
  );
}

type RenderBlock =
  | { kind: "group"; group: PluginConfigFieldGroup; fields: PluginConfigField[] }
  | { kind: "field"; field: PluginConfigField };

function groupFields(fields: PluginConfigField[]): RenderBlock[] {
  const blocks: RenderBlock[] = [];
  const groupIndex = new Map<string, number>();
  for (const f of fields) {
    const g = f.group;
    if (!g) {
      blocks.push({ kind: "field", field: f });
      continue;
    }
    const existing = groupIndex.get(g.id);
    if (existing !== undefined) {
      const block = blocks[existing] as Extract<RenderBlock, { kind: "group" }>;
      block.fields.push(f);
    } else {
      groupIndex.set(g.id, blocks.length);
      blocks.push({ kind: "group", group: g, fields: [f] });
    }
  }
  return blocks;
}

/** Bordered card grouping related fields. The optional `badge`
 *  shows up as an uppercase pill so concepts like "worker type"
 *  read as a label rather than free text. When `headerToggle` is
 *  passed, its switch is rendered on the right side of the
 *  header bar so the master enable/disable can sit next to the
 *  group title instead of taking its own row. */
function ConfigGroupCard({
  group,
  headerToggle,
  children,
}: {
  group: PluginConfigFieldGroup;
  headerToggle?: {
    field: PluginConfigField;
    value: boolean;
    onChange: (v: boolean) => void;
  } | null;
  children: React.ReactNode;
}) {
  const empty =
    !children ||
    (Array.isArray(children) && children.every((c) => c == null || c === false));
  return (
    <section className="rounded-md border border-gray-800 bg-gray-900/30 p-4">
      <header className="flex flex-wrap items-center gap-2">
        {group.badge && (
          <span className="rounded border border-gray-700 bg-gray-800/60 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-gray-400">
            {group.badge}
          </span>
        )}
        <h3 className="text-[13px] font-semibold text-gray-100">
          {group.label}
        </h3>
        {headerToggle && (
          <ConfigToggle
            active={headerToggle.value}
            onClick={() => headerToggle.onChange(!headerToggle.value)}
            ariaLabel={headerToggle.field.label}
          />
        )}
      </header>
      {group.description && (
        <p className="mt-1 text-[11px] leading-relaxed text-gray-500">
          {group.description}
        </p>
      )}
      {!empty && <div className="mt-3 space-y-4">{children}</div>}
    </section>
  );
}

function ConfigFieldRow({
  field,
  value,
  onChange,
}: {
  field: PluginConfigField;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  if (field.kind === "boolean") {
    const checked = value === true;
    return (
      <div className="flex items-start justify-between gap-3 text-[12px]">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-gray-200">{field.label}</div>
          {field.description && (
            <p className="mt-0.5 text-[11px] leading-relaxed text-gray-500">
              {field.description}
            </p>
          )}
        </div>
        <ConfigToggle
          active={checked}
          onClick={() => onChange(!checked)}
          ariaLabel={field.label}
        />
      </div>
    );
  }
  if (field.kind === "number") {
    const numValue =
      typeof value === "number"
        ? value
        : typeof value === "string" && value.trim() !== ""
          ? Number(value)
          : (field.default ?? 0);
    return (
      <div className="text-[12px]">
        <label className="mb-1 block font-medium text-gray-200">
          {field.label}
        </label>
        <div className="flex items-center gap-2">
          <input
            type="number"
            value={Number.isFinite(numValue) ? numValue : 0}
            min={field.min}
            max={field.max}
            step={field.step}
            onChange={(e) => onChange(Number(e.target.value))}
            className={`${INPUT_BASE} w-40`}
          />
          {field.unit && (
            <span className="text-[11px] text-gray-500">{field.unit}</span>
          )}
        </div>
        {field.description && (
          <p className="mt-1 text-[11px] leading-relaxed text-gray-500">
            {field.description}
          </p>
        )}
      </div>
    );
  }
  if (field.kind === "select") {
    const sel =
      typeof value === "string"
        ? value
        : (field.default ?? field.options[0]?.value ?? "");
    return (
      <div className="text-[12px]">
        <label className="mb-1 block font-medium text-gray-200">
          {field.label}
        </label>
        <select
          value={sel}
          onChange={(e) => onChange(e.target.value)}
          className={INPUT_BASE}
        >
          {field.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {field.description && (
          <p className="mt-1 text-[11px] leading-relaxed text-gray-500">
            {field.description}
          </p>
        )}
      </div>
    );
  }
  if (field.kind === "secret") {
    // The redacted shape coming back from the server looks like
    // `{ __secret: true, set: <bool> }`. The user typing into the
    // input gives us a plain string, which we just pass through to
    // the form's value map. On save, splitSecrets sees a plain
    // string and persists it; sees the redacted shape and treats
    // it as a no-op; sees `{ __secret: true, clear: true }` (set
    // by the Clear button below) and removes the secret.
    const isRedacted =
      value !== null &&
      typeof value === "object" &&
      (value as { __secret?: unknown }).__secret === true;
    const isSet =
      isRedacted && (value as { set?: unknown }).set === true;
    const stringValue = typeof value === "string" ? value : "";
    return (
      <div className="text-[12px]">
        <label className="mb-1 block font-medium text-gray-200">
          {field.label}
          {isSet ? (
            <span className="ml-2 rounded bg-emerald-700/40 px-1.5 py-0.5 text-[10px] uppercase text-emerald-300">
              set
            </span>
          ) : null}
        </label>
        <div className="flex items-center gap-2">
          <input
            type="password"
            value={stringValue}
            placeholder={
              isSet
                ? "••• stored — type a new value to replace, or click Clear"
                : (field.placeholder ?? "")
            }
            autoComplete="new-password"
            spellCheck={false}
            onChange={(e) => onChange(e.target.value)}
            className={INPUT_BASE}
          />
          {isSet && stringValue === "" && (
            <button
              type="button"
              className="shrink-0 rounded border border-gray-700 bg-gray-900 px-2 py-1 text-[11px] text-gray-300 hover:border-rose-700 hover:text-rose-300"
              onClick={() => onChange({ __secret: true, clear: true })}
            >
              Clear
            </button>
          )}
        </div>
        {field.description && (
          <p className="mt-1 text-[11px] leading-relaxed text-gray-500">
            {field.description}
          </p>
        )}
      </div>
    );
  }
  // string
  const s = typeof value === "string" ? value : (field.default ?? "");
  return (
    <div className="text-[12px]">
      <label className="mb-1 block font-medium text-gray-200">
        {field.label}
      </label>
      {field.multiline ? (
        <textarea
          value={s}
          rows={3}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
          className={`${INPUT_BASE} resize-y`}
        />
      ) : (
        <input
          type="text"
          value={s}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
          className={INPUT_BASE}
        />
      )}
      {field.description && (
        <p className="mt-1 text-[11px] leading-relaxed text-gray-500">
          {field.description}
        </p>
      )}
    </div>
  );
}

/** Build the form's flat-key value map by reading the current
 *  config object via dotted paths, falling back to schema defaults. */
function initialValues(
  fields: PluginConfigField[],
  config: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const persisted = readDottedKey(config, f.key);
    if (persisted !== undefined) {
      out[f.key] = persisted;
      continue;
    }
    if (f.kind === "boolean") out[f.key] = f.default ?? false;
    else if (f.kind === "number") out[f.key] = f.default ?? 0;
    else if (f.kind === "secret")
      // No `default` for secrets (manifests must not bake in keys).
      // Initial value is the empty string — the field will render
      // as "unset" and the input will be empty. The persisted
      // shape (redacted obj) only appears here when the form
      // re-loads after a save with stored credentials.
      out[f.key] = "";
    else if (f.kind === "select")
      out[f.key] = f.default ?? f.options[0]?.value ?? "";
    else out[f.key] = f.default ?? "";
  }
  return out;
}

function readDottedKey(obj: unknown, key: string): unknown {
  let cursor: unknown = obj;
  for (const part of key.split(".")) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function nestValuesByDottedKey(
  flat: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(flat)) {
    const parts = key.split(".");
    let cursor: Record<string, unknown> = out;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (
        typeof cursor[part] !== "object" ||
        cursor[part] === null ||
        Array.isArray(cursor[part])
      ) {
        cursor[part] = {};
      }
      cursor = cursor[part] as Record<string, unknown>;
    }
    cursor[parts[parts.length - 1]] = val;
  }
  return out;
}

function shallowEqualValues(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) if (a[k] !== b[k]) return false;
  return true;
}
