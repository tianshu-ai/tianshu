// Doctor plugin — server side.
//
// Exposes GET /api/p/doctor/check and GET /api/p/doctor/status.
// The actual diagnostic logic lives in the host's setup/doctor.ts;
// the host injects `collectDoctorReport` into globalThis at boot
// so this plugin can call it without a compile-time dependency on
// @tianshu/server (which would create a circular dep).
//
// Pattern matches the plugin-sdk's client-side globalThis slots
// (useComposer, useTheme, etc.) — just on the server side.

import type { Request, Response } from "express";
import type {
  PluginContext,
  PluginServerExports,
  PluginServerModule,
} from "@tianshu-ai/plugin-sdk";

// ── globalThis bridge ──────────────────────────────────────────
// The host stores `collectDoctorReport` here at boot time. See
// packages/server/src/index.ts for the registration side.

interface DoctorGlobalSlot {
  __tianshuDoctorCheck__?: (opts?: {
    probeProviders?: boolean;
    skipVersionCheck?: boolean;
  }) => Promise<{
    groups: Array<{
      title: string;
      lines: Array<{
        severity: "ok" | "warning" | "blocker";
        text: string;
        detail?: string;
      }>;
    }>;
    ok: number;
    warning: number;
    blocker: number;
  }>;
}

function doctorSlot(): DoctorGlobalSlot {
  return globalThis as unknown as DoctorGlobalSlot;
}

// ── Plugin module ──────────────────────────────────────────────

const plugin: PluginServerModule = {
  activate(_ctx: PluginContext): PluginServerExports {
    return {
      routes: {
        getCheck: async (_req: Request, res: Response) => {
          const runner = doctorSlot().__tianshuDoctorCheck__;
          if (!runner) {
            res.status(503).json({
              error: "doctor_not_available",
              message:
                "collectDoctorReport was not injected by the host. " +
                "This plugin only works inside the tianshu server process.",
            });
            return;
          }
          try {
            const report = await runner({ probeProviders: true });
            res.json(report);
          } catch (err) {
            res.status(500).json({
              error: "doctor_failed",
              message: err instanceof Error ? err.message : String(err),
            });
          }
        },

        getStatus: (_req: Request, res: Response) => {
          const available = !!doctorSlot().__tianshuDoctorCheck__;
          res.json({ ok: available });
        },
      },
    };
  },
};

export default plugin;
