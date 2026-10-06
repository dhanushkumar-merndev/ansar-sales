import type { LeadOutcome } from "@/lib/constants";

export type PipelineStage = { id: string; name: string; position: number; kind: LeadOutcome; color: StageColor; archived_at: string | null };

export const STAGE_COLORS = ["slate", "blue", "sky", "violet", "amber", "orange", "pink", "emerald", "red"] as const;
export type StageColor = (typeof STAGE_COLORS)[number];

/** Badge classes per stage colour (dark theme). Text labels always accompany the colour. */
export const STAGE_BADGE: Record<StageColor, string> = {
  slate: "border-white/25 bg-white/10 text-white",
  blue: "border-blue-400/30 bg-blue-400/10 text-blue-300",
  sky: "border-sky-400/30 bg-sky-400/10 text-sky-300",
  violet: "border-violet-400/30 bg-violet-400/10 text-violet-300",
  amber: "border-amber-400/30 bg-amber-400/10 text-amber-300",
  orange: "border-orange-400/30 bg-orange-400/10 text-orange-300",
  pink: "border-pink-400/30 bg-pink-400/10 text-pink-300",
  emerald: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
  red: "border-red-400/30 bg-red-400/10 text-red-300",
};

/** Chart colours per stage colour. */
export const STAGE_HEX: Record<StageColor, string> = {
  slate: "#a1a1aa", blue: "#60a5fa", sky: "#38bdf8", violet: "#a78bfa", amber: "#fbbf24",
  orange: "#fb923c", pink: "#f472b6", emerald: "#34d399", red: "#f87171",
};

export const stageHex = (color: string | null | undefined) => STAGE_HEX[(color ?? "slate") as StageColor] ?? STAGE_HEX.slate;
