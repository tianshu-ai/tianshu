/**
 * Generate HTML cards for ProjectHub tool results.
 * Rendered as MCP-UI iframes in the chat.
 *
 * Theme-adaptive: reads the host's CSS custom properties (--color-*)
 * at runtime via window.parent (same-origin sandbox), so cards
 * follow dark / light / classical themes automatically.
 */
import type { PHIssue, PHIssueDetail, PHProject } from "./types.js";

// The script reads host CSS variables and maps them to local --ph-* vars.
// Falls back to sensible dark defaults if the host isn't accessible.
const THEME_SCRIPT = `
<script>
(function() {
  var r = document.documentElement.style;
  try {
    var h = window.parent.document.documentElement;
    var cs = window.parent.getComputedStyle(h);
    var v = function(n) { return cs.getPropertyValue(n).trim(); };
    r.setProperty('--ph-bg-surface',  v('--color-bg-surface')  || '#131a27');
    r.setProperty('--ph-bg-hover',    v('--color-bg-hover')    || '#1a2332');
    r.setProperty('--ph-fg',          v('--color-fg-default')  || '#e2e8f0');
    r.setProperty('--ph-fg-muted',    v('--color-fg-muted')    || '#cbd5e1');
    r.setProperty('--ph-fg-faint',    v('--color-fg-faint')    || '#828b99');
    r.setProperty('--ph-fg-fainter',  v('--color-fg-fainter')  || '#737d8c');
    r.setProperty('--ph-border',      v('--color-border-default') || '#1e2a3a');
    r.setProperty('--ph-border-subtle', v('--color-border-subtle') || '#141c2a');
    r.setProperty('--ph-accent',      v('--color-accent')      || '#c9a96e');
    r.setProperty('--ph-link',        v('--color-link')        || '#d4b876');
    r.setProperty('--ph-success',     v('--color-success')     || '#10b981');
    r.setProperty('--ph-warning',     v('--color-warning')     || '#f59e0b');
    r.setProperty('--ph-danger',      v('--color-danger')      || '#f43f5e');
    // Report content height for auto-sizing
    requestAnimationFrame(function() {
      var h = document.body.scrollHeight;
      window.parent.postMessage({ type: 'tianshu:board_resize', height: h }, '*');
    });
  } catch(e) {}
})();
<\/script>
`;

const STYLE = `
<style>
  :root {
    --ph-bg-surface: #131a27;
    --ph-bg-hover: #1a2332;
    --ph-fg: #e2e8f0;
    --ph-fg-muted: #cbd5e1;
    --ph-fg-faint: #828b99;
    --ph-fg-fainter: #737d8c;
    --ph-border: #1e2a3a;
    --ph-border-subtle: #141c2a;
    --ph-accent: #c9a96e;
    --ph-link: #d4b876;
    --ph-success: #10b981;
    --ph-warning: #f59e0b;
    --ph-danger: #f43f5e;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { background: var(--ph-bg-surface); }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: var(--ph-fg); font-size: 13px; line-height: 1.5; }
  a { color: var(--ph-link); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .card { background: var(--ph-bg-surface); border: 1px solid var(--ph-border); border-radius: 12px; overflow: hidden; }
  .card + .card { margin-top: 6px; }
  .card-row { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--ph-border-subtle); transition: background 0.15s; }
  .card-row:hover { background: var(--ph-bg-hover); }
  .card-row:last-child { border-bottom: none; }
  .id { font-weight: 600; color: var(--ph-link); font-size: 12px; min-width: 36px; }
  .subject { flex: 1; font-weight: 500; color: var(--ph-fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .badge { display: inline-flex; align-items: center; padding: 1px 8px; border-radius: 9999px; font-size: 11px; font-weight: 500; white-space: nowrap; border: 1px solid transparent; }
  .badge-tracker { background: color-mix(in srgb, var(--ph-accent) 15%, transparent); color: var(--ph-accent); }
  .badge-status { background: color-mix(in srgb, var(--ph-success) 15%, transparent); color: var(--ph-success); }
  .badge-status.closed { background: color-mix(in srgb, var(--ph-fg-faint) 15%, transparent); color: var(--ph-fg-faint); }
  .badge-priority { background: color-mix(in srgb, var(--ph-warning) 15%, transparent); color: var(--ph-warning); }
  .badge-priority.low { background: color-mix(in srgb, var(--ph-fg-fainter) 12%, transparent); color: var(--ph-fg-fainter); }
  .badge-priority.high, .badge-priority.urgent { background: color-mix(in srgb, var(--ph-danger) 15%, transparent); color: var(--ph-danger); }
  .assignee { color: var(--ph-fg-faint); font-size: 12px; }
  .meta { color: var(--ph-fg-fainter); font-size: 11px; }
  .detail-header { padding: 12px 16px; border-bottom: 1px solid var(--ph-border-subtle); }
  .detail-header h2 { font-size: 15px; color: var(--ph-fg); margin-bottom: 4px; }
  .detail-body { padding: 12px 16px; }
  .detail-body p { margin-bottom: 8px; color: var(--ph-fg-muted); }
  .detail-meta { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 8px; }
  .detail-meta span { font-size: 12px; color: var(--ph-fg-faint); }
  .journals-section { margin-top: 8px; }
  .journals-divider {
    font-size: 11px; font-weight: 600; color: var(--ph-fg-fainter);
    text-transform: uppercase; letter-spacing: 0.05em;
    padding: 8px 16px 4px;
    border-top: 2px solid var(--ph-border-subtle);
  }
  .journal { padding: 10px 16px; border-top: 1px solid var(--ph-border-subtle); }
  .journal-header { font-size: 11px; color: var(--ph-fg-fainter); margin-bottom: 4px; }
  .journal-body { color: var(--ph-fg-muted); font-size: 13px; }
  .progress-bar { height: 4px; background: var(--ph-border); border-radius: 2px; overflow: hidden; width: 48px; }
  .progress-fill { height: 100%; background: var(--ph-accent); border-radius: 2px; }
  .summary { padding: 8px 12px; color: var(--ph-fg-fainter); font-size: 12px; }
</style>
`;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function priorityClass(p: string): string {
  const l = p.toLowerCase();
  if (l.includes("low")) return "low";
  if (l.includes("high")) return "high";
  if (l.includes("urgent") || l.includes("immediate")) return "urgent";
  return "";
}

function statusClass(s: string): string {
  const l = s.toLowerCase();
  if (l.includes("closed") || l.includes("rejected") || l.includes("done")) return "closed";
  return "";
}

function head(): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${STYLE}${THEME_SCRIPT}</head><body>`;
}

export function issueListHtml(issues: PHIssue[], total: number): string {
  const rows = issues.map((i) => `
    <div class="card-row">
      <a class="id" href="${esc(i.webUrl)}" target="_blank">#${esc(String(i.id))}</a>
      <a class="subject" href="${esc(i.webUrl)}" target="_blank">${esc(i.subject)}</a>
      ${i.tracker ? `<span class="badge badge-tracker">${esc(i.tracker)}</span>` : ""}
      <span class="badge badge-status ${statusClass(i.status)}">${esc(i.status)}</span>
      <span class="badge badge-priority ${priorityClass(i.priority)}">${esc(i.priority)}</span>
      ${i.assignee ? `<span class="assignee">${esc(i.assignee)}</span>` : ""}
      ${i.doneRatio != null && i.doneRatio > 0 ? `<div class="progress-bar"><div class="progress-fill" style="width:${i.doneRatio}%"></div></div>` : ""}
    </div>
  `).join("");

  return `${head()}
    <div class="card">${rows}</div>
    <div class="summary">${total} issue${total !== 1 ? "s" : ""} total</div>
  </body></html>`;
}

export function issueDetailHtml(issue: PHIssueDetail): string {
  const journals = (issue.journals ?? [])
    .filter((j) => j.notes)
    .slice(-5)
    .map((j) => `
      <div class="journal">
        <div class="journal-header">${esc(j.user)} · ${esc(j.createdAt)}</div>
        <div class="journal-body">${esc(j.notes)}</div>
      </div>
    `).join("");

  return `${head()}
    <div class="card">
      <div class="detail-header">
        <h2><a href="${esc(issue.webUrl)}" target="_blank">#${esc(String(issue.id))}</a> ${esc(issue.subject)}</h2>
        <div style="display:flex;gap:6px;margin-top:6px;">
          ${issue.tracker ? `<span class="badge badge-tracker">${esc(issue.tracker)}</span>` : ""}
          <span class="badge badge-status ${statusClass(issue.status)}">${esc(issue.status)}</span>
          <span class="badge badge-priority ${priorityClass(issue.priority)}">${esc(issue.priority)}</span>
        </div>
      </div>
      <div class="detail-body">
        ${issue.description ? `<p>${esc(issue.description)}</p>` : "<p><em>No description</em></p>"}
        <div class="detail-meta">
          <span>Author: ${esc(issue.author)}</span>
          ${issue.assignee ? `<span>Assignee: ${esc(issue.assignee)}</span>` : ""}
          ${issue.doneRatio != null ? `<span>Progress: ${issue.doneRatio}%</span>` : ""}
          ${issue.dueDate ? `<span>Due: ${esc(issue.dueDate)}</span>` : ""}
          <span>Updated: ${esc(issue.updatedAt)}</span>
        </div>
      </div>
      ${journals ? `
        <div class="journals-section">
          <div class="journals-divider">Comments</div>
          ${journals}
        </div>` : ""}
    </div>
  </body></html>`;
}

export function projectListHtml(projects: PHProject[], total: number): string {
  const rows = projects.map((p) => `
    <div class="card-row">
      <span class="id">${esc(p.identifier)}</span>
      <span class="subject">${esc(p.name)}</span>
      <span class="meta">${esc(p.description).slice(0, 80)}</span>
    </div>
  `).join("");

  return `${head()}
    <div class="card">${rows}</div>
    <div class="summary">${total} project${total !== 1 ? "s" : ""}</div>
  </body></html>`;
}
