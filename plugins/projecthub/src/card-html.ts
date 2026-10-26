/**
 * Generate HTML cards for ProjectHub tool results.
 * Rendered as MCP-UI iframes in the chat.
 */
import type { PHIssue, PHIssueDetail, PHProject } from "./types.js";

const STYLE = `
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: transparent; color: #e2e8f0; font-size: 13px; line-height: 1.5; }
  a { color: #60a5fa; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .card { background: rgba(15,23,42,0.6); border: 1px solid rgba(148,163,184,0.15); border-radius: 12px; overflow: hidden; }
  .card + .card { margin-top: 6px; }
  .card-row { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid rgba(148,163,184,0.08); }
  .card-row:last-child { border-bottom: none; }
  .id { font-weight: 600; color: #60a5fa; font-size: 12px; min-width: 36px; }
  .subject { flex: 1; font-weight: 500; color: #f1f5f9; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .badge { display: inline-flex; align-items: center; padding: 1px 8px; border-radius: 9999px; font-size: 11px; font-weight: 500; white-space: nowrap; }
  .badge-status { background: rgba(34,197,94,0.15); color: #4ade80; }
  .badge-status.closed { background: rgba(148,163,184,0.15); color: #94a3b8; }
  .badge-priority { background: rgba(251,146,60,0.15); color: #fb923c; }
  .badge-priority.low { background: rgba(148,163,184,0.1); color: #94a3b8; }
  .badge-priority.high, .badge-priority.urgent { background: rgba(239,68,68,0.15); color: #f87171; }
  .badge-tracker { background: rgba(139,92,246,0.15); color: #a78bfa; }
  .assignee { color: #94a3b8; font-size: 12px; }
  .meta { color: #64748b; font-size: 11px; }
  .detail-header { padding: 12px 16px; border-bottom: 1px solid rgba(148,163,184,0.1); }
  .detail-header h2 { font-size: 15px; color: #f1f5f9; margin-bottom: 4px; }
  .detail-body { padding: 12px 16px; }
  .detail-body p { margin-bottom: 8px; color: #cbd5e1; }
  .detail-meta { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 8px; }
  .detail-meta span { font-size: 12px; color: #94a3b8; }
  .journal { padding: 10px 16px; border-top: 1px solid rgba(148,163,184,0.06); }
  .journal-header { font-size: 11px; color: #64748b; margin-bottom: 4px; }
  .journal-body { color: #cbd5e1; font-size: 13px; }
  .progress-bar { height: 4px; background: rgba(148,163,184,0.15); border-radius: 2px; overflow: hidden; width: 48px; }
  .progress-fill { height: 100%; background: #60a5fa; border-radius: 2px; }
  .summary { padding: 8px 12px; color: #64748b; font-size: 12px; }
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

  return `<!DOCTYPE html><html><head>${STYLE}</head><body>
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

  return `<!DOCTYPE html><html><head>${STYLE}</head><body>
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
      ${journals}
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

  return `<!DOCTYPE html><html><head>${STYLE}</head><body>
    <div class="card">${rows}</div>
    <div class="summary">${total} project${total !== 1 ? "s" : ""}</div>
  </body></html>`;
}
