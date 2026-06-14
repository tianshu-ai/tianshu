// Top-level router. Two surfaces today:
//   - "/"        → ChatLayout (default chat shell)
//   - "/admin/*" → AdminShell (per-tenant management UI; plugins
//                  contribute pages via manifest.contributes.adminPages[])
//
// Authentication / role gating lands when the closed-source repo's
// JWT auth is ported over. For now every signed-in user can see the
// admin shell; plugins are expected to gate destructive endpoints
// themselves until then.

import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import ChatLayout from "./components/ChatLayout";
import AdminShell from "./components/admin/AdminShell";
import FileOpenDialog from "./components/FileOpenDialog";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<ChatLayout />} />
        <Route path="/admin/*" element={<AdminShell />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {/* Always-mounted overlay listening for `tianshu:files:open`
       *  intents emitted by useOpenFile() callers (workboard task
       *  cards, attachment renderers, ...). Lives outside the
       *  router so the dialog persists across route changes. */}
      <FileOpenDialog />
    </BrowserRouter>
  );
}
