// Host-owned tool: `solution`.
//
// Lets the MAIN agent inspect + edit the tenant's Workforce
// Studio solutions programmatically — the same operations the
// Studio UI exposes (list / get / extract / save / diff /
// activate), so a user can say "tighten the coder worker's
// execution bias and drop the meme-maker skill" and the agent
// edits a solution, shows a diff, and (on explicit user okay)
// activates it.
//
// Safety (per Yu's decisions):
//   - Main agent only. `available()` returns false for workers —
//     a worker must not rewrite global config.
//   - Read actions (list/get/diff/active) run freely.
//   - `save` writes a solution file but does NOT change the live
//     system (inert until activated).
//   - `activate` is the one action that changes the running
//     system. tianshu's agent-tool layer has no built-in human
//     approval card, so we gate it ourselves: activate is a
//     no-op preview unless the caller passes confirm:true. The
//     agent is instructed to obtain explicit user consent first;
//     the preview return tells it to ask.
//
// The tool talks to the host.solutions capability rather than the
// store directly, so it stays behind the same boundary the
// Studio plugin uses.

import { Type } from "typebox";
import type {
  AgentTool,
  AgentToolContext,
  SolutionsCapability,
  SolutionSpecInput,
} from "@tianshu-ai/plugin-sdk";

export const SOLUTION_TOOL_NAME = "solution";

type Result = { ok: boolean; text: string };

function ok(text: string): Result {
  return { ok: true, text };
}
function err(text: string): Result {
  return { ok: false, text };
}

export function buildSolutionTool(): AgentTool {
  return {
    schema: {
      name: SOLUTION_TOOL_NAME,
      description:
        "Inspect and edit Workforce Studio solutions for this tenant — declarative agent configurations (main-agent prompt overrides + skill/tool deny lists, per-worker prompt / tools / skills, plugin enable-set). Use it to help the user maintain and tune their agent setup. Actions: `list` (all solutions + which is active), `get` (one solution's full config), `diff` (a solution vs the running system), `extract` (snapshot current reality into a new named solution), `save` (create/update a solution — writes to disk, does NOT go live), `activate` (make a solution the live config — CHANGES THE RUNNING SYSTEM; requires confirm:true and explicit user consent). Typical flow: get/extract → save edits → diff → ask the user → activate with confirm:true. Saving never affects the live agent; only activate does.",
      parameters: Type.Object({
        action: Type.Union(
          [
            Type.Literal("list"),
            Type.Literal("get"),
            Type.Literal("diff"),
            Type.Literal("extract"),
            Type.Literal("save"),
            Type.Literal("activate"),
            Type.Literal("active"),
          ],
          {
            description:
              "list = all solutions; get = one (needs slug); diff = solution vs reality (needs slug); extract = snapshot reality to a new solution (needs slug+name); save = create/update (needs spec); activate = go live (needs slug + confirm:true); active = which solution is currently live.",
          },
        ),
        slug: Type.Optional(
          Type.String({
            description:
              "Solution slug. Required for get / diff / extract / activate. Lowercase letters, digits, hyphen, underscore.",
          }),
        ),
        name: Type.Optional(
          Type.String({ description: "Display name (extract / save)." }),
        ),
        description: Type.Optional(
          Type.String({ description: "Description (extract / save)." }),
        ),
        spec: Type.Optional(
          Type.String({
            description:
              "Full SolutionSpecInput for `save`, as a JSON STRING (not an object). Get an existing solution first (action=get), edit the fields you want, and pass the edited spec back here JSON-stringified. Shape: { slug, name, description, plugins:{enabled:[]}, mainAgent:{tenantPrompt, skillsAllow, skillsDeny, toolsAllow, toolsDeny, overrides:{executionBias,replyStyle,userOnboarding}, customFragments:[{id,title,body}]}, workers:[{slug,kind,name,description,modelId,enabled,systemPrompt,toolsAllow,skillsAllow,source}] }. Each customFragments item MUST be {id (stable slug), title, body (the fragment text)} — NOT `text`; a missing/empty body or id is rejected, not silently dropped.",
          }),
        ),
        confirm: Type.Optional(
          Type.Boolean({
            description:
              "Required true to actually activate. Without it, activate only previews (returns the diff + a note to get user consent). Only set true after the user has explicitly agreed to go live.",
          }),
        ),
      }),
    },

    // Main agent only — workers must not rewrite global config.
    available(ctx: AgentToolContext) {
      return !ctx.agentScope || ctx.agentScope.kind === "main";
    },

    async execute(args: unknown, ctx: AgentToolContext): Promise<Result> {
      const cap = ctx.capabilities.get<SolutionsCapability>("host.solutions");
      if (!cap) {
        return err(
          "solution: host.solutions capability unavailable (host too old or studio disabled).",
        );
      }
      const p = (args ?? {}) as {
        action?: string;
        slug?: string;
        name?: string;
        description?: string;
        spec?: unknown;
        confirm?: boolean;
      };
      const userId = ctx.userId;
      const action = String(p.action ?? "");

      try {
        switch (action) {
          case "list": {
            const sols = cap.list(userId);
            return ok(JSON.stringify(sols, null, 2));
          }
          case "active": {
            const slug = cap.getActive(userId);
            return ok(
              slug
                ? `Active solution: ${slug}`
                : "No solution is active (running pure host defaults).",
            );
          }
          case "get": {
            if (!p.slug) return err("solution get: slug required.");
            const detail = cap.get(userId, p.slug);
            if (!detail) return err(`solution get: "${p.slug}" not found.`);
            return ok(JSON.stringify(detail, null, 2));
          }
          case "diff": {
            if (!p.slug) return err("solution diff: slug required.");
            const d = cap.diff(userId, { slug: p.slug, against: "reality" });
            return ok(JSON.stringify(d, null, 2));
          }
          case "extract": {
            if (!p.slug) return err("solution extract: slug required.");
            const detail = cap.extract(userId, {
              slug: p.slug,
              name: p.name,
              description: p.description,
            });
            return ok(
              `Extracted reality into solution "${detail.spec.slug}". ${detail.spec.workers.length} workers, ${detail.spec.plugins.enabled.length} plugins captured. Not live — activate to apply.`,
            );
          }
          case "save": {
            // spec arrives as a JSON string (preferred — nested
            // objects survive the tool-call boundary intact), but
            // tolerate an already-parsed object too in case the
            // framework hands one through.
            let parsed: unknown = p.spec;
            if (typeof p.spec === "string") {
              const s = p.spec.trim();
              if (s.length === 0) {
                return err(
                  "solution save: spec is empty. Pass the SolutionSpecInput as a JSON string (action=get first to see the shape).",
                );
              }
              try {
                parsed = JSON.parse(s);
              } catch (e) {
                return err(
                  `solution save: spec is not valid JSON: ${
                    e instanceof Error ? e.message : String(e)
                  }`,
                );
              }
            }
            if (!parsed || typeof parsed !== "object") {
              return err(
                "solution save: spec required — pass the SolutionSpecInput as a JSON string (action=get first to see the shape).",
              );
            }
            if (!(parsed as { slug?: unknown }).slug) {
              return err(
                "solution save: spec.slug is required (the solution to create/update).",
              );
            }
            const detail = cap.save(userId, parsed as SolutionSpecInput);
            return ok(
              `Saved solution "${detail.spec.slug}" to disk. This does NOT change the running system — call diff to review, then activate (with the user's consent) to go live.`,
            );
          }
          case "activate": {
            if (!p.slug) return err("solution activate: slug required.");
            // Self-imposed confirm gate: no auto-activation.
            if (p.confirm !== true) {
              const d = cap.diff(userId, {
                slug: p.slug,
                against: "reality",
              });
              return ok(
                `Activation of "${p.slug}" NOT performed — confirm:true is required and the user must explicitly agree to change the live system first.\n\nChanges vs the running system:\n${JSON.stringify(
                  d,
                  null,
                  2,
                )}\n\nAsk the user to confirm, then call again with confirm:true.`,
              );
            }
            const r = await cap.activate(userId, p.slug);
            return ok(
              `Activated "${r.activeSlug}". It is now the live solution; ${r.appliedWorkers.length} workers updated. Takes effect on the next agent turn.`,
            );
          }
          default:
            return err(
              `solution: unknown action "${action}". Use list|get|diff|extract|save|activate|active.`,
            );
        }
      } catch (e) {
        return err(
          `solution ${action}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  };
}
