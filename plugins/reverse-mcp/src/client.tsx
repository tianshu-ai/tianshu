// Local Bridge panel.
//
// Shows the user everything needed to connect their machine:
//   1. A ready-to-run command (copy button) that starts the local
//      bridge CLI, pre-filled with the WS URL + a freshly-minted token.
//   2. Short step-by-step instructions.
//   3. A live list of connected devices + the tools they expose,
//      refreshed on register/unregister events.
//
// The bridge is scoped to THIS user's sessions (main + workers), never
// shared across users — unlike a normal backend MCP server.

import { useCallback, useEffect, useState } from "react";
import { Plug, Copy, Check, RefreshCw, Laptop } from "lucide-react";
import type { PanelProps, PluginClientExports } from "@tianshu-ai/plugin-sdk/client";
import { subscribeToWsEvent } from "@tianshu-ai/plugin-sdk/client";

const API_BASE = "/api/p/reverse-mcp";

interface Conn {
  deviceId: string;
  label: string;
  connectedAt: number;
  tools: string[];
}
interface ConnectInfo {
  wsUrl: string;
  authEnabled: boolean;
  token: string;
  expiresAt: number | null;
  baseCommand: string;
  command: string;
}

type BrowserEngine = "own" | "stealth";

/** A monospace command line with a copy button. */
function CmdBlock(props: {
  label: string;
  text: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="mb-1 flex items-stretch gap-1">
      <pre className="flex-1 overflow-x-auto rounded-md bg-bg-raised px-2 py-1.5 text-[11px] leading-relaxed text-fg-default">
        {props.text}
      </pre>
      <button
        onClick={props.onCopy}
        title={`Copy ${props.label}`}
        className="flex items-center rounded px-1.5 text-fg-faint hover:text-fg-default hover:bg-bg-hover transition-colors"
      >
        {props.copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
    </div>
  );
}

function BridgePanel(_props: PanelProps) {
  const [info, setInfo] = useState<ConnectInfo | null>(null);
  const [conns, setConns] = useState<Conn[]>([]);
  const [loading, setLoading] = useState(true);
  // Capability selection (model A: the panel composes the command; the
  // user runs it on their own machine — nothing is toggled remotely).
  const [browserOn, setBrowserOn] = useState(true);
  const [engine, setEngine] = useState<BrowserEngine>("own");
  const [headless, setHeadless] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Common CLI args (server + token + capability flags). Both the
  // global `tsbridge` command and the one-off `npx` form take these.
  const argsSuffix = (() => {
    if (!info) return "";
    const parts = [`--server ${info.wsUrl}`];
    if (info.authEnabled && info.token) parts.push(`--token ${info.token}`);
    if (!browserOn) parts.push("--no-browser");
    else {
      if (engine === "stealth") parts.push("--browser-engine stealth");
      if (headless) parts.push("--headless");
    }
    return parts.join(" ");
  })();
  // Global install path: run `tsbridge <args>` after `npm i -g`.
  const globalCmd = info ? `tsbridge ${argsSuffix}` : "…";
  // Zero-install path.
  const INSTALL_CMD = "npm i -g @tianshu-ai/local-bridge";
  const INSTALL_APP_CMD = "tsbridge install-app --run";
  // Config string for the menu-bar app's “Paste from tianshu” button.
  const configUrl = info
    ? `tsbridge://configure?server=${encodeURIComponent(info.wsUrl)}` +
      (info.authEnabled && info.token ? `&token=${encodeURIComponent(info.token)}` : "") +
      `&engine=${engine}&headless=${headless ? "1" : "0"}`
    : "…";

  const fetchInfo = useCallback(() => {
    fetch(`${API_BASE}/connect-info`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((res: ConnectInfo) => setInfo(res))
      .catch(() => setInfo(null));
  }, []);

  const fetchConns = useCallback(() => {
    fetch(`${API_BASE}/connections`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((res: { connections: Conn[] }) => setConns(res.connections ?? []))
      .catch(() => setConns([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchInfo();
    fetchConns();
    return subscribeToWsEvent<{ type: string; event?: string }>("plugin_event", (ev) => {
      if (ev.event && /reverse-mcp|connections_changed/i.test(ev.event)) fetchConns();
    });
  }, [fetchInfo, fetchConns]);

  const copy = useCallback((key: string, text: string) => {
    if (!text || text === "…") return;
    void navigator.clipboard.writeText(text).then(() => {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1800);
    });
  }, []);

  return (
    <div className="flex h-full flex-col overflow-y-auto text-fg-default">
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-border-subtle px-3 py-1.5">
        <Plug size={13} className="text-fg-faint" />
        <span className="text-xs font-medium">Local Bridge</span>
        <button
          onClick={() => {
            fetchInfo();
            fetchConns();
          }}
          title="Refresh"
          className="ml-auto rounded p-1 text-fg-faint hover:text-fg-default hover:bg-bg-hover transition-colors"
        >
          <RefreshCw size={12} />
        </button>
      </div>

      <div className="space-y-4 px-3 py-3 text-[12px]">
        <p className="leading-relaxed text-fg-muted">
          Connect software on your own machine (browser, files, shell) into
          tianshu. Run the command below on your computer; it starts a small
          local client that dials in and registers its tools. Only{" "}
          <b>your</b> sessions can use them.
        </p>

        {/* Step-by-step */}
        <ol className="list-decimal space-y-1 pl-5 text-fg-muted">
          <li>Copy the command below.</li>
          <li>Run it in a terminal on the machine you want to bridge.</li>
          <li>
            The device appears under <b>Connected devices</b> and the agent can
            use its tools.
          </li>
        </ol>

        {/* Capabilities to expose */}
        <div>
          <div className="mb-1 font-medium text-fg-default">Capabilities</div>
          <div className="space-y-1.5">
            {/* browser */}
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={browserOn}
                onChange={(e) => setBrowserOn(e.target.checked)}
              />
              <span className="font-medium">Browser</span>
              <span className="text-[10px] text-fg-fainter">control a local browser</span>
            </label>
            {browserOn && (
              <div className="ml-6 flex flex-col gap-1">
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="engine"
                    checked={engine === "own"}
                    onChange={() => setEngine("own")}
                  />
                  <span>Your own Chrome</span>
                  <span className="text-[10px] text-fg-fainter">
                    real cookies + fingerprint, no download
                  </span>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="engine"
                    checked={engine === "stealth"}
                    onChange={() => setEngine("stealth")}
                  />
                  <span>Stealth browser</span>
                  <span className="text-[10px] text-fg-fainter">
                    anti-bot-detection (CloakBrowser); ~200MB first run
                  </span>
                </label>
                <label className="mt-0.5 flex items-center gap-2 border-t border-border-subtle pt-1">
                  <input
                    type="checkbox"
                    checked={headless}
                    onChange={(e) => setHeadless(e.target.checked)}
                  />
                  <span>Headless</span>
                  <span className="text-[10px] text-fg-fainter">
                    no window (default: show the browser)
                  </span>
                </label>
              </div>
            )}
            {/* shell — coming soon */}
            <label className="flex items-center gap-2 opacity-50">
              <input type="checkbox" disabled />
              <span className="font-medium">Shell</span>
              <span className="rounded bg-bg-raised px-1.5 py-0.5 text-[10px] text-fg-fainter">
                Coming soon
              </span>
            </label>
            {/* files — coming soon */}
            <label className="flex items-center gap-2 opacity-50">
              <input type="checkbox" disabled />
              <span className="font-medium">Files</span>
              <span className="rounded bg-bg-raised px-1.5 py-0.5 text-[10px] text-fg-fainter">
                Coming soon
              </span>
            </label>
          </div>
        </div>

        {/* Step 1 — prerequisite: install the CLI once */}
        <div>
          <div className="mb-1 font-medium text-fg-default">
            Step 1 · Install the bridge (once)
          </div>
          <CmdBlock
            label="install"
            text={INSTALL_CMD}
            copied={copiedKey === "install"}
            onCopy={() => copy("install", INSTALL_CMD)}
          />
          <p className="text-[10px] text-fg-fainter">
            Requires Node.js. Then pick one of the two ways below.
          </p>
        </div>

        {/* Step 2 — choose: CLI or menu-bar app */}
        <div>
          <div className="mb-1 font-medium text-fg-default">Step 2 · Start it</div>

          {/* Option A: run from the command line */}
          <div className="mb-0.5 text-[11px] font-medium text-fg-default">
            A · Command line
          </div>
          <div className="mb-0.5 text-[10px] text-fg-fainter">
            Run this in a terminal (uses your current picks above):
          </div>
          <CmdBlock
            label="run"
            text={globalCmd}
            copied={copiedKey === "global"}
            onCopy={() => copy("global", globalCmd)}
          />

          {/* Option B: macOS menu-bar app */}
          <div className="mt-3 mb-0.5 text-[11px] font-medium text-fg-default">
            B · Menu-bar app (macOS)
          </div>
          <div className="mb-0.5 text-[10px] text-fg-fainter">
            1. Install the app:
          </div>
          <CmdBlock
            label="install-app"
            text={INSTALL_APP_CMD}
            copied={copiedKey === "install-app"}
            onCopy={() => copy("install-app", INSTALL_APP_CMD)}
          />
          <div className="mb-0.5 text-[10px] text-fg-fainter">
            2. Copy this config, then click the menu-bar icon → Settings →
            “Paste from tianshu”:
          </div>
          <CmdBlock
            label="config"
            text={configUrl}
            copied={copiedKey === "config"}
            onCopy={() => copy("config", configUrl)}
          />

          {info?.authEnabled && info.expiresAt && (
            <p className="mt-2 text-[10px] text-fg-fainter">
              Token valid until {new Date(info.expiresAt).toLocaleDateString()}.
              Refresh this panel to mint a new one; the old command keeps
              working until it expires.
            </p>
          )}
          {info && !info.authEnabled && (
            <p className="mt-2 text-[10px] text-fg-fainter">
              Auth is disabled on this server — no token needed.
            </p>
          )}
          <p className="mt-1 text-[10px] text-fg-fainter">
            Update later with <code>tsbridge update</code>.
          </p>
        </div>

        {/* Connected devices */}
        <div>
          <div className="mb-1 font-medium text-fg-default">Connected devices</div>
          {loading ? (
            <div className="text-[11px] text-fg-fainter">Loading…</div>
          ) : conns.length === 0 ? (
            <div className="rounded border border-dashed border-border-subtle px-3 py-3 text-center text-[11px] text-fg-fainter">
              No devices connected yet. Run the command above.
            </div>
          ) : (
            <div className="space-y-2">
              {conns.map((c) => (
                <div
                  key={c.deviceId}
                  className="rounded border border-border-subtle bg-bg-base/50 px-2 py-1.5"
                >
                  <div className="flex items-center gap-1.5">
                    <Laptop size={12} className="text-brand-400" />
                    <span className="font-medium">{c.label || c.deviceId}</span>
                    <span className="ml-auto text-[10px] text-fg-fainter">
                      {c.tools.length} tool(s)
                    </span>
                  </div>
                  {c.tools.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {c.tools.map((t) => (
                        <span
                          key={t}
                          className="rounded bg-bg-raised px-1.5 py-0.5 text-[10px] text-fg-muted"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const clientExports: PluginClientExports = {
  components: { BridgePanel },
};

export default clientExports;
