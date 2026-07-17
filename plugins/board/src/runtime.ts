// Source for the tiny runtime we inject into every board page so the
// agent's `board_act` tool can drive the live DOM (click / fill /
// query / wait_for / eval / dump). Ported from the closed-source
// Tianshu board-runtime.
//
// It's exported as a string (not bundled) because it runs inside the
// board iframe's own document — no module system, no imports. The
// board server injects it as an inline <script> when serving
// index.html.
//
// Wire protocol (window.postMessage between BoardPanel ↔ iframe):
//   parent → iframe : { type:"tianshu:board_act", reqId, op:{...} }
//   iframe → parent : { type:"tianshu:board_act_response", reqId, ok, data?, error? }
//   iframe → parent : { type:"tianshu:board_runtime_ready" }  (on load)

export const BOARD_RUNTIME_SOURCE = `(function () {
  'use strict';
  if (window.__tianshuBoardRuntime) return;
  window.__tianshuBoardRuntime = true;

  function $(sel) {
    if (!sel) throw new Error('selector is required');
    var el = document.querySelector(sel);
    if (!el) throw new Error('no element matches: ' + sel);
    return el;
  }

  function readAttr(el, attr) {
    if (!attr || attr === 'text') return (el.textContent || '').trim();
    if (attr === 'html') return el.innerHTML;
    if (attr === 'value') return el.value;
    return el.getAttribute(attr);
  }

  function setFormValue(el, value) {
    var tag = (el.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      var proto = Object.getPrototypeOf(el);
      var desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, value);
      else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    el.textContent = value;
    return true;
  }

  function dump(rootSelector, mode) {
    var root = rootSelector ? $(rootSelector) : document.body;
    if (mode === 'text') {
      return (root.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 4000);
    }
    var sel = 'a,button,input,select,textarea,form,[role],[contenteditable],h1,h2,h3,label';
    var nodes = root.querySelectorAll(sel);
    var out = [];
    for (var i = 0; i < nodes.length && i < 200; i++) {
      var n = nodes[i];
      var bits = [n.tagName.toLowerCase()];
      if (n.id) bits.push('#' + n.id);
      if (n.name) bits.push('[name=' + n.name + ']');
      if (n.type) bits.push('[type=' + n.type + ']');
      var cls = (typeof n.className === 'string' ? n.className : '').trim();
      if (cls) bits.push('.' + cls.split(/\\s+/).slice(0, 2).join('.'));
      var label = n.textContent ? n.textContent.trim().slice(0, 40) : '';
      if (n.value) label = label || String(n.value).slice(0, 40);
      if (n.placeholder) label = label || n.placeholder;
      out.push(bits.join('') + (label ? ' :: ' + label : ''));
    }
    return out.join('\\n');
  }

  function waitFor(sel, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector(sel)) { resolve(true); return; }
      var done = false;
      var obs = new MutationObserver(function () {
        if (done) return;
        if (document.querySelector(sel)) {
          done = true; obs.disconnect(); resolve(true);
        }
      });
      obs.observe(document.body || document.documentElement, { childList: true, subtree: true });
      setTimeout(function () {
        if (done) return;
        done = true; obs.disconnect();
        reject(new Error('wait_for timed out: ' + sel));
      }, timeoutMs || 5000);
    });
  }

  async function execute(op) {
    var a = op.action;
    if (a === 'query') return readAttr($(op.selector), op.attr);
    if (a === 'click') { $(op.selector).click(); return null; }
    if (a === 'fill') { setFormValue($(op.selector), op.value); return null; }
    if (a === 'wait_for') { await waitFor(op.selector, op.timeout_ms); return true; }
    if (a === 'eval') {
      var fn = new Function('return (async () => { ' + op.script + ' })()');
      return await fn();
    }
    if (a === 'dump') return dump(op.selector, op.mode);
    throw new Error('unknown action: ' + a);
  }

  window.addEventListener('message', async function (ev) {
    if (ev.source !== window.parent) return;
    var msg = ev.data;
    if (!msg || msg.type !== 'tianshu:board_act') return;
    try {
      var data = await execute(msg.op || {});
      window.parent.postMessage({ type: 'tianshu:board_act_response', reqId: msg.reqId, ok: true, data: data }, '*');
    } catch (err) {
      window.parent.postMessage({ type: 'tianshu:board_act_response', reqId: msg.reqId, ok: false, error: (err && err.message) || String(err) }, '*');
    }
  });

  try { window.parent.postMessage({ type: 'tianshu:board_runtime_ready' }, '*'); } catch (e) {}
})();
`;

/** Inject the runtime as an inline <script> into a board's HTML.
 *  Inserted right before </body> (or appended if there's no body tag)
 *  so the board's own DOM exists before the runtime attaches. */
export function injectRuntime(html: string): string {
  const tag = `<script>${BOARD_RUNTIME_SOURCE}</script>`;
  const idx = html.lastIndexOf("</body>");
  if (idx >= 0) return html.slice(0, idx) + tag + html.slice(idx);
  return html + tag;
}
