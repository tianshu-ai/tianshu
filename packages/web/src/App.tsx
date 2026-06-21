// Top-level router.
//
// Routes are scoped under `/tenants/:tenantId/users/:userId/...`
// so identity is visible in the address bar (bookmarkable,
// shareable, glance-able). `dev-identity.ts` ensures we always
// land on a canonical URL with the cookie matching before this
// component renders.
//
// Two surfaces today, both under the identity prefix:
//   /tenants/:t/users/:u/        → ChatLayout (default chat shell)
//   /tenants/:t/users/:u/admin/* → AdminShell (per-tenant management)
//
// Anything outside the prefix gets redirected to the prefixed
// equivalent via the catch-all `*` route — main.tsx's boot
// handles the same case earlier, this is the React-side safety
// net for in-app navigations that drop the prefix by accident.
//
// Authentication / role gating lands when the closed-source repo's
// JWT auth is ported over. For now every signed-in user can see the
// admin shell; plugins are expected to gate destructive endpoints
// themselves until then.

import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import ChatLayout from "./components/ChatLayout";
import AdminShell from "./components/admin/AdminShell";
import FileOpenDialog from "./components/FileOpenDialog";
import DevIdentityBadge from "./components/DevIdentityBadge";
import { buildIdentityPath } from "./dev-identity";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Identity-scoped surfaces. */}
        <Route path="/tenants/:tenantId/users/:userId">
          <Route index element={<ChatLayout />} />
          <Route path="admin/*" element={<AdminShell />} />
          {/* Catch-all under identity → bounce to the identity
              root (which renders the chat). Avoids dead links
              like /tenants/foo/users/bar/typo404 silently
              landing on the chat with confusing history. */}
          <Route path="*" element={<Navigate to="" replace />} />
        </Route>
        {/* Anything outside the identity prefix → reconstruct
            under the current identity (cookie / fallback).
            main.tsx normally handles this at boot; this route
            covers post-boot navigations that miss the prefix. */}
        <Route
          path="*"
          element={<Navigate to={buildIdentityPath("/")} replace />}
        />
      </Routes>
      {/* Always-mounted overlay listening for `tianshu:files:open`
       *  intents emitted by useOpenFile() callers (workboard task
       *  cards, attachment renderers, ...). Lives outside the
       *  router so the dialog persists across route changes. */}
      <FileOpenDialog />
      {/* Tiny corner badge shown only when a non-default dev
       *  identity cookie is set. Click to reset back to
       *  default/dev. Hidden in production (no cookie = no badge). */}
      <DevIdentityBadge />
    </BrowserRouter>
  );
}
