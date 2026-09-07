// Shell plugin server — publish/preview/status routes.
//
// The agent writes shell drafts to the user's home:
//   <userHome>/_tenant/shell/index.html
//
// The "publish" action copies that directory to the tenant shared dir:
//   <tenantShared>/shell/
//
// The shell-spa middleware only serves from the tenant shared dir,
// so publishing is what makes the custom UI go live.

import fs from "node:fs";
import path from "node:path";

function userIdFromReq(req) {
  return req.ctx?.userId ?? "";
}

function buildRoutes(ctx) {
  // GET /api/p/example-shell/status
  // Returns draft and published shell state for this user/tenant.
  const getStatus = (req, res) => {
    const userId = userIdFromReq(req);
    if (!userId) return res.status(401).json({ error: "no user context" });

    const userShellDir = path.join(ctx.userHomeDir(userId), "_tenant", "shell");
    const tenantShellDir = path.join(ctx.workspaceDir, "_tenant", "shell");

    const draftExists = fs.existsSync(path.join(userShellDir, "index.html"));
    const publishedExists = fs.existsSync(path.join(tenantShellDir, "index.html"));

    let draftFiles = [];
    if (draftExists) {
      draftFiles = listFilesRecursive(userShellDir).map(f => ({
        path: path.relative(userShellDir, f),
        size: fs.statSync(f).size,
        mtime: fs.statSync(f).mtime.toISOString(),
      }));
    }

    let publishedFiles = [];
    if (publishedExists) {
      publishedFiles = listFilesRecursive(tenantShellDir).map(f => ({
        path: path.relative(tenantShellDir, f),
        size: fs.statSync(f).size,
        mtime: fs.statSync(f).mtime.toISOString(),
      }));
    }

    res.json({
      draft: { exists: draftExists, files: draftFiles, dir: userShellDir },
      published: { exists: publishedExists, files: publishedFiles, dir: tenantShellDir },
    });
  };

  // POST /api/p/example-shell/publish
  // Copy user's draft shell to tenant shared dir (goes live).
  const publish = (req, res) => {
    const userId = userIdFromReq(req);
    if (!userId) return res.status(401).json({ error: "no user context" });

    const userShellDir = path.join(ctx.userHomeDir(userId), "_tenant", "shell");
    const tenantShellDir = path.join(ctx.workspaceDir, "_tenant", "shell");

    if (!fs.existsSync(path.join(userShellDir, "index.html"))) {
      return res.status(404).json({
        error: "no draft",
        message: "No shell draft found. Ask the agent to write _tenant/shell/index.html first.",
      });
    }

    // Clean the published dir and copy everything from draft
    if (fs.existsSync(tenantShellDir)) {
      fs.rmSync(tenantShellDir, { recursive: true, force: true });
    }
    copyDirRecursive(userShellDir, tenantShellDir);

    const files = listFilesRecursive(tenantShellDir).map(f =>
      path.relative(tenantShellDir, f)
    );

    ctx.log.info(`shell published: ${files.length} files from user ${userId}`);
    res.json({ ok: true, files });
  };

  // GET /api/p/example-shell/preview
  // Serve the user's draft index.html for iframe preview.
  const preview = (req, res) => {
    const userId = userIdFromReq(req);
    if (!userId) return res.status(401).json({ error: "no user context" });

    const userShellDir = path.join(ctx.userHomeDir(userId), "_tenant", "shell");
    const indexPath = path.join(userShellDir, "index.html");

    if (!fs.existsSync(indexPath)) {
      return res.status(404).send("No draft shell found.");
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(fs.readFileSync(indexPath));
  };

  // POST /api/p/example-shell/session
  // Ensure a dedicated shell session exists for this user.
  // Returns the sessionId to use with WS prompt messages.
  const ensureSession = (req, res) => {
    const userId = userIdFromReq(req);
    if (!userId) return res.status(401).json({ error: "no user context" });

    const sessionId = `shell_${userId}`;

    // Check if it already exists
    const existing = ctx.db
      .prepare(`SELECT id, status FROM sessions WHERE id = ? AND user_id = ?`)
      .get(sessionId, userId);

    if (existing) {
      return res.json({ sessionId, created: false });
    }

    // Create a dedicated session for the shell UI
    const now = Date.now();
    ctx.db
      .prepare(
        `INSERT INTO sessions (id, user_id, status, kind, created_at, title)
         VALUES (?, ?, 'active', 'user', ?, ?)`,
      )
      .run(sessionId, userId, now, 'Custom Shell');

    ctx.log.info(`shell session created: ${sessionId} for user ${userId}`);
    return res.json({ sessionId, created: true });
  };

  return { getStatus, publish, preview, ensureSession };
}

function listFilesRecursive(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFilesRecursive(full));
    } else {
      results.push(full);
    }
  }
  return results;
}

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

const plugin = {
  activate(ctx) {
    ctx.log.info("example-shell activated");
    return {
      routes: buildRoutes(ctx),
    };
  },
  async deactivate() {},
};

export const activate = plugin.activate.bind(plugin);
export const deactivate = plugin.deactivate?.bind(plugin);
export default plugin;
