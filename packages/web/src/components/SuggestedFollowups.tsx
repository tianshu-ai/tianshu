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

  // Find last assistant message
  const lastAssistant = [...messages]
    .reverse()
    .find((m) => m.role === "assistant" && m.text.trim().length > 10);
  if (!lastAssistant) return [];

  // Don't suggest on very old messages — only if it's the tail
  const lastMsg = messages[messages.length - 1];
  if (lastMsg.role !== "assistant") return [];

  const text = lastAssistant.text;
  const suggestions: string[] = [];

  // Pattern 1: If the message contains a question, suggest answering it
  const questions = text.match(/[^.!?]*\?/g);
  if (questions && questions.length > 0) {
    const lastQ = questions[questions.length - 1].trim();
    if (lastQ.length > 5 && lastQ.length < 80) {
      // The assistant asked something — suggest a response
      if (/要.*吗|需要.*吗|想.*吗|是否|好吗|可以吗|怎么样/u.test(lastQ)) {
        suggestions.push("好的，开始吧");
      }
      if (/还是|或者|哪个/u.test(lastQ)) {
        suggestions.push("你推荐哪个？");
      }
    }
  }

  // Pattern 2: If the message mentions specific topics, suggest diving deeper
  if (/代码|代码库|文件|组件|函数/u.test(text)) {
    suggestions.push("详细解释一下");
  }
  if (/错误|bug|问题|失败|报错/u.test(text)) {
    suggestions.push("帮我修复这个问题");
  }
  if (/任务|task|worker|工作/u.test(text)) {
    suggestions.push("查看当前任务状态");
  }

  // Pattern 3: Generic useful follow-ups based on content type
  if (text.length > 200 && suggestions.length < 2) {
    suggestions.push("总结一下要点");
  }
  if (/步骤|第[一二三四五1-5]|首先|然后|最后/u.test(text) && suggestions.length < 3) {
    suggestions.push("继续下一步");
  }

  // Pattern 4: If message contains code blocks
  if (/```/.test(text) && suggestions.length < 3) {
    suggestions.push("运行这段代码");
  }

  // Pattern 5: If message is a greeting or short
  if (text.length < 50) {
    return []; // Don't clutter short exchanges
  }

  // Deduplicate and limit to 3
  return [...new Set(suggestions)].slice(0, 3);
}
