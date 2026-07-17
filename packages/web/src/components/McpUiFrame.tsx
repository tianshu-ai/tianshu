// Renders an MCP-UI resource (ui:// ) inside a sandboxed iframe and
// bridges the MCP-UI postMessage protocol between the guest UI and the
// host chat.
//
// Protocol (legacy MCP-UI, https://mcpui.dev):
//   guest → host  window.parent.postMessage({ type, messageId?, payload }, '*')
//     type='tool'   payload={toolName, params}  → ask host to run a tool
//     type='prompt' payload={prompt}            → ask host to run a prompt
//     type='link'   payload={url}               → open a link
//     type='notify' payload={message}           → side-effect notice (logged)
//     type='intent' payload={intent, params}    → user intent (logged; no
//                                                  host-defined handler yet)
//   host → guest (only when the guest sent a messageId):
//     { type:'ui-message-received', messageId }
//     { type:'ui-message-response', messageId, payload:{ response | error } }
//
// Rendering:
//   - text/html content is written into the iframe via `srcdoc`, run
//     under a restrictive sandbox (scripts allowed, but NOT
//     allow-same-origin, so the guest is a null origin and can't touch
//     the host cookies / DOM).
//
// Host-action mapping (MVP):
//   - prompt → sendPrompt(prompt)
//   - tool   → sendPrompt(a wrapped instruction naming the tool+params).
//     There is no "execute a tool directly, bypassing the agent" API on
//     the web side yet; routing through the agent keeps the action
//     visible and auditable. A direct-call path can be added later.
//   - link   → window.open(url)
//   - notify/intent → console only (no host side-effects wired yet).

import { useEffect, useRef } from "react";
import type { McpUiResource } from "../types/chat";
import { useChatStore } from "../stores/chat-store";
import { getMcpUiHtml } from "../lib/mcp-ui-cache";
import { tianshuWs } from "../lib/ws";

interface McpUiMessage {
  type: string;
  messageId?: string;
  payload?: Record<string, unknown>;
}

export default function McpUiFrame({ ui }: { ui: McpUiResource }) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const sendPrompt = useChatStore((s) => s.sendPrompt);
  // The html isn't carried on the message (A1: only {uri, mimeType}
  // is). We look it up from the per-uri cache, which the live
  // tool_result populated (and which survives reloads via
  // sessionStorage). If it's a cold reload in a fresh tab the html
  // won't be there — show a hint to re-run the tool rather than a
  // blank frame. `ui.html` is honoured too for any caller that still
  // passes it inline.
  const html = ui.html ?? getMcpUiHtml(ui.uri) ?? null;

  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      // Only accept messages from *our* iframe's content window. With a
      // null-origin sandbox we can't check ev.origin, so identity is by
      // source window reference.
      const frame = iframeRef.current;
      if (!frame || ev.source !== frame.contentWindow) return;
      const msg = ev.data as McpUiMessage | undefined;
      if (!msg || typeof msg.type !== "string") return;

      const ack = (payload: Record<string, unknown>) => {
        if (!msg.messageId) return;
        frame.contentWindow?.postMessage(
          { type: "ui-message-response", messageId: msg.messageId, payload },
          "*",
        );
      };
      // Immediate receipt ack (before we act) — matches the spec's
      // ui-message-received, so async guests can show "processing".
      if (msg.messageId) {
        frame.contentWindow?.postMessage(
          { type: "ui-message-received", messageId: msg.messageId },
          "*",
        );
      }

      const p = msg.payload ?? {};
      try {
        switch (msg.type) {
          case "prompt": {
            const prompt = typeof p.prompt === "string" ? p.prompt : "";
            if (prompt) sendPrompt(prompt);
            ack({ response: { ok: true } });
            break;
          }
          case "tool": {
            const toolName = typeof p.toolName === "string" ? p.toolName : "";
            const params = p.params ?? {};
            if (toolName) {
              // No direct tool-exec API on the web side yet; route the
              // request through the agent as an instruction so it stays
              // visible + auditable.
              sendPrompt(
                `The interactive UI requested tool \`${toolName}\` with arguments:\n\`\`\`json\n${JSON.stringify(
                  params,
                  null,
                  2,
                )}\n\`\`\`\nCall it now.`,
              );
            }
            ack({ response: { ok: true } });
            break;
          }
          case "link": {
            const url = typeof p.url === "string" ? p.url : "";
            if (url) window.open(url, "_blank", "noopener,noreferrer");
            ack({ response: { ok: true } });
            break;
          }
          case "notify":
          case "intent": {
            // No host-defined side effects yet — surface for debugging.
            // eslint-disable-next-line no-console
            console.debug("[mcp-ui] guest action", msg.type, p);
            ack({ response: { ok: true } });
            break;
          }
          default: {
            // eslint-disable-next-line no-console
            console.debug("[mcp-ui] unhandled guest message type", msg.type);
          }
        }
      } catch (err) {
        ack({ error: { message: err instanceof Error ? err.message : String(err) } });
      }
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [sendPrompt]);

  // board_act bridge: when this frame is showing a board (ui://board/*),
  // relay the agent's board_act ops into the injected board runtime and
  // send the result back to the host. This makes board_act work whether
  // the board is opened in the side panel or dropped into the chat via
  // show_board (both carry the same injected runtime).
  //
  // The board runtime and the McpUiFrame message handler above use
  // disjoint message types (tianshu:board_act* vs prompt/tool/link), so
  // they coexist on the same iframe without interfering.
  useEffect(() => {
    if (!ui.uri.startsWith("ui://board/")) return;
    const offReq = tianshuWs.on("plugin_event", (ev) => {
      if (ev.event !== "board:board_act_request") return;
      const payload = ev.payload as { reqId?: string; op?: unknown } | undefined;
      const reqId = payload?.reqId;
      const win = iframeRef.current?.contentWindow;
      if (!reqId || !win) return;
      win.postMessage(
        { type: "tianshu:board_act", reqId, op: payload?.op },
        "*",
      );
    });
    const onResp = (ev: MessageEvent) => {
      const win = iframeRef.current?.contentWindow;
      if (win && ev.source !== win) return;
      const msg = ev.data as {
        type?: string;
        reqId?: string;
        ok?: boolean;
        data?: unknown;
        error?: string;
      } | null;
      if (!msg || msg.type !== "tianshu:board_act_response" || !msg.reqId) return;
      tianshuWs.send({
        type: "board_act_response",
        reqId: msg.reqId,
        ok: msg.ok === true,
        data: msg.data,
        error: msg.error,
      });
    };
    window.addEventListener("message", onResp);
    return () => {
      offReq();
      window.removeEventListener("message", onResp);
    };
  }, [ui.uri]);

  if (html === null) {
    // Cold reload with no cached html for this uri (tab was closed,
    // or the tool ran in another session). The reference is here but
    // the payload isn't — tell the user how to get it back.
    return (
      <div className="w-full bg-bg-elevated/60 px-3 py-4 text-[11px] text-fg-faint">
        Interactive UI ({ui.uri}) isn’t loaded in this tab. Re-run the tool
        to display it.
      </div>
    );
  }

  return (
    <iframe
      ref={iframeRef}
      title={ui.uri}
      srcDoc={html}
      // scripts yes; same-origin NO (null origin isolates the guest
      // from host cookies/DOM). allow-forms/popups keep basic UIs
      // working; popups route through our link handler in practice.
      sandbox="allow-scripts allow-forms allow-popups"
      className="w-full border-0 bg-white"
      style={{ height: 360 }}
    />
  );
}
