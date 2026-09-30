// ask_user host tool — suspend the agent loop until the user
// picks an option in the UI.
//
// The tool executor:
//   1. Registers a pending interaction (pending-interactions.ts)
//   2. Broadcasts an "interaction_request" event via WS
//   3. Returns a Promise that resolves when the user responds
//
// The WS handler resolves the Promise when it receives
// "interaction_response" from the client.

import { Type } from "typebox";
import type { Tool } from "@earendil-works/pi-ai";
import type { ToolExecutor } from "../../tools/index.js";
import {
  createInteraction,
  type InteractionOption,
} from "../pending-interactions.js";

export interface AskUserOpts {
  /** Session id for the current chat session. */
  sessionId: string;
  /** Broadcast a WS event to the connected client. */
  broadcast: (event: unknown) => void;
  /** AbortSignal from the current agent run. */
  signal?: AbortSignal;
}

const schema: Tool = {
  name: "ask_user",
  description:
    "Present a question with clickable options to the user and wait " +
    "for their selection. The UI renders buttons; the user clicks one " +
    "(or several if multiSelect is true) and the tool returns their " +
    "choice(s). Use this instead of asking the user to type a letter " +
    "— it's faster and less error-prone.\n\n" +
    "The tool SUSPENDS the agent loop until the user responds or the " +
    "timeout expires (default 5 minutes). Do not call ask_user and " +
    "then immediately call another tool in the same turn — the second " +
    "call won't run until ask_user resolves.",
  parameters: {
    type: "object",
    properties: {
      question: Type.String({
        description: "The question to display above the option buttons.",
      }),
      options: Type.Array(
        Type.Object({
          value: Type.String({
            description: "The value returned when this option is selected.",
          }),
          label: Type.String({
            description:
              "Button label. Keep it short (2-6 words). Emoji prefix recommended.",
          }),
          description: Type.Optional(
            Type.String({
              description:
                "Optional one-line description shown below the label.",
            }),
          ),
        }),
        {
          description: "The selectable options. 2-8 items.",
          minItems: 2,
          maxItems: 8,
        },
      ),
      multiSelect: Type.Optional(
        Type.Boolean({
          description:
            "When true, the user can select multiple options. " +
            "Default false (single select).",
        }),
      ),
    },
    required: ["question", "options"],
  } as never,
};

export function buildAskUserTool(
  opts: AskUserOpts,
): { schema: Tool; executor: ToolExecutor } {
  return {
    schema,
    executor: async (args) => {
      const question = String(args.question ?? "").trim();
      if (!question) {
        return { text: JSON.stringify({ error: "empty_question" }) };
      }

      const rawOptions = args.options;
      if (!Array.isArray(rawOptions) || rawOptions.length < 2) {
        return {
          text: JSON.stringify({
            error: "invalid_options",
            detail: "At least 2 options are required.",
          }),
        };
      }

      const options: InteractionOption[] = rawOptions.map((o: Record<string, unknown>) => ({
        value: String(o.value ?? ""),
        label: String(o.label ?? ""),
        description: o.description ? String(o.description) : undefined,
      }));

      const multiSelect = args.multiSelect === true;

      const { request, result } = createInteraction(
        opts.sessionId,
        question,
        options,
        {
          multiSelect,
          signal: opts.signal,
        },
      );

      // Push the interaction request to the client via WS
      opts.broadcast({
        type: "interaction_request",
        ...request,
      });

      try {
        const value = await result;
        // Return the user's selection as the tool result
        return {
          text: JSON.stringify({
            status: "answered",
            question,
            selection: value,
          }),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("timeout")) {
          return {
            text: JSON.stringify({
              status: "timeout",
              question,
              detail: "User did not respond within the time limit.",
            }),
          };
        }
        if (msg.includes("abort")) {
          return {
            text: JSON.stringify({
              status: "aborted",
              question,
              detail: "Session was aborted.",
            }),
          };
        }
        return {
          text: JSON.stringify({
            status: "error",
            question,
            detail: msg,
          }),
        };
      }
    },
  };
}
