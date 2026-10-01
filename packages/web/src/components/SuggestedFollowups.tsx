import { useMemo } from "react";
import { Sparkles } from "lucide-react";
import { useChatStore } from "../stores/chat-store";
import type { WireMessage } from "../../../server/src/chat/ws-protocol";

/**
 * Renders 2-3 clickable follow-up suggestion chips below the last
 * assistant message. Pure frontend — no backend changes needed.
 *
 * Strategy: extract actionable follow-ups from the assistant's last
 * reply using lightweight heuristics. Shows only when the agent is
 * idle and the last message is from the assistant.
 */
export default function SuggestedFollowups() {
  const messages = useChatStore((s) => s.messages);
  const isStreaming = useChatStore((s) => s.isStreaming);

  const suggestions = useMemo(
    () => generateSuggestions(messages),
    [messages],
  );

  // Only show when idle and we have suggestions
  if (isStreaming || suggestions.length === 0) return null;

  const handleClick = (text: string) => {
    const store = useChatStore.getState();
    store.sendPrompt(text);
  };

  return (
    <div className="flex flex-wrap gap-2 pt-2 pb-1">
      {suggestions.map((s, i) => (
        <button
          key={i}
          type="button"
          onClick={() => handleClick(s)}
          className="inline-flex items-center gap-1.5 rounded-full border border-border-default bg-bg-elevated/50 px-3.5 py-1.5 text-xs text-fg-muted transition-all hover:border-accent hover:text-accent hover:bg-accent-faint"
        >
          <Sparkles size={12} className="flex-shrink-0 opacity-50" />
          <span>{s}</span>
        </button>
      ))}
    </div>
  );
}

// ── Suggestion generation ──────────────────────────────────────

function generateSuggestions(messages: WireMessage[]): string[] {
  if (messages.length === 0) return [];

  // Only show when the last message is from the assistant
  const lastMsg = messages[messages.length - 1];
  if (lastMsg.role !== "assistant") return [];

  const text = lastMsg.text;
  if (text.length < 50) return []; // Don't clutter short exchanges

  const suggestions: string[] = [];

  // Priority 1: If the assistant explicitly asked a question, suggest answering it
  const lines = text.split("\n");
  const lastLine = lines.filter((l) => l.trim().length > 0).pop() ?? "";
  if (/[？?]\s*$/.test(lastLine)) {
    // The reply ends with a question — suggest affirmative + alternative
    if (/要.*吗|需要.*吗|想.*吗|好吗|可以吗|怎么样|试试/u.test(lastLine)) {
      suggestions.push("好的，开始吧");
      suggestions.push("先等等，我想想");
    } else if (/还是|或者|哪个|先/u.test(lastLine)) {
      suggestions.push("你推荐哪个？");
      suggestions.push("都做了吧");
    } else if (/什么|做什么|干什么|怎么/u.test(lastLine)) {
      // Open-ended question like "有什么需要做的？"
      return []; // Let the user think
    }
  }

  // Priority 2: Content-aware follow-ups (only if we don't already have 2+)
  if (suggestions.length < 2) {
    // Code explanation → ask to run or explain
    if (/```/.test(text)) {
      suggestions.push("解释一下这段代码");
    }
    // Error/problem discussed → suggest fix
    if (/错误|bug|失败|报错|crash|异常|不工作/u.test(text) && !/已修复|修好了|解决了/u.test(text)) {
      suggestions.push("帮我修一下");
    }
    // Long explanation → suggest summary
    if (text.length > 500 && suggestions.length < 2) {
      suggestions.push("总结一下要点");
    }
    // Steps/procedure → suggest next step
    if (/步骤|第[一二三四五六七]|首先|接下来|然后|最后/u.test(text) && suggestions.length < 3) {
      suggestions.push("继续");
    }
  }

  // Priority 3: If the response has tool calls, suggest exploring results
  if (lastMsg.toolCalls && lastMsg.toolCalls.length > 0 && suggestions.length < 3) {
    suggestions.push("详细说说结果");
  }

  // Deduplicate and limit to 3
  return [...new Set(suggestions)].slice(0, 3);
}
