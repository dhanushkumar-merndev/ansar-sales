import { timingSafeEqual } from "node:crypto";

export function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Extracts the linking token from a private-chat "/start <token>" message. */
export function parseStartCommand(update: unknown): { token: string; chatId: number; username: string | null } | null {
  const msg = (update as { message?: { text?: string; chat?: { id?: number; type?: string }; from?: { username?: string } } })?.message;
  if (!msg?.text || msg.chat?.type !== "private" || typeof msg.chat.id !== "number") return null;
  const match = /^\/start(?:@\w+)?\s+([a-f0-9]{64})$/.exec(msg.text.trim());
  if (!match) return null;
  return { token: match[1], chatId: msg.chat.id, username: msg.from?.username ?? null };
}
