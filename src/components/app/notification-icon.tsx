import {
  AlarmClock, Bell, CalendarClock, ChartColumn, CircleAlert, CircleCheck, CircleX, CreditCard, FolderOpen, Handshake, Hourglass,
  Leaf, ListTodo, Mail, MapPin, PartyPopper, PencilLine, Pin, Receipt, Repeat, Send, Siren, ThumbsUp, TrendingUp, TriangleAlert,
  Trophy, UserCheck, UserPlus, Wallet, Wrench, type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

type Tone = "urgent" | "warn" | "good" | "plain";

// The notification text is shared with Telegram, which keeps its emoji; the app shows an icon instead.
// Keyed by the title's leading emoji (variation selectors removed), so every kind and variant is covered.
const ICONS: Record<string, [LucideIcon, Tone]> = {
  "⏰": [AlarmClock, "plain"], "🔁": [Repeat, "plain"], "💸": [Receipt, "plain"], "💰": [Wallet, "plain"],
  "🆕": [UserPlus, "plain"], "👤": [UserCheck, "plain"], "🏆": [Trophy, "good"], "❌": [CircleX, "urgent"],
  "📅": [CalendarClock, "plain"], "⚠": [TriangleAlert, "urgent"], "📁": [FolderOpen, "plain"], "📋": [ListTodo, "plain"],
  "📊": [ChartColumn, "plain"], "📈": [TrendingUp, "plain"], "🤝": [Handshake, "plain"], "✅": [CircleCheck, "good"],
  "🌿": [Leaf, "plain"], "📌": [Pin, "plain"], "⏳": [Hourglass, "warn"], "🚨": [Siren, "urgent"], "📤": [Send, "plain"],
  "✏": [PencilLine, "warn"], "📍": [MapPin, "plain"], "💳": [CreditCard, "plain"], "🔴": [CircleAlert, "urgent"],
  "👍": [ThumbsUp, "good"], "📨": [Mail, "plain"], "🔧": [Wrench, "warn"], "🎉": [PartyPopper, "good"],
};

const TONE: Record<Tone, string> = {
  urgent: "bg-red-500/10 text-red-400",
  warn: "bg-amber-500/10 text-amber-400",
  good: "bg-emerald-500/10 text-emerald-400",
  plain: "bg-muted text-muted-foreground",
};

export function NotificationIcon({ emoji, className }: { emoji: string; className?: string }) {
  const [Icon, tone] = ICONS[emoji.replace(/️/g, "")] ?? [Bell, "plain"];
  return (
    <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-md", TONE[tone], className)} aria-hidden>
      <Icon className="size-4" />
    </span>
  );
}
