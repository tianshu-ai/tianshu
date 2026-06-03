export interface WireMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  createdAt: number;
}
