"use client";

import { useRealtime } from "@/components/providers/realtime-provider";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

const LABEL = { live: "Live", connecting: "Connecting…", offline: "Reconnecting…" } as const;

export function SiteHeader() {
  const { status } = useRealtime();
  return (
    <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center justify-between border-b border-white/[0.08] bg-background/85 px-4 backdrop-blur-md sm:px-6 lg:px-8">
      <div className="flex items-center gap-3">
        <SidebarTrigger className="-ml-2 text-muted-foreground hover:bg-white/[0.08] hover:text-foreground" />
      </div>
      <div className="flex items-center gap-2">
        <div
          className="flex items-center gap-1.5 rounded-full border border-white/[0.08] bg-card/70 px-2.5 py-1 text-xs text-muted-foreground shadow-xs"
          role="status"
          aria-live="polite"
        >
          <span
            className={cn(
              "size-1.5 rounded-full transition-all",
              status === "live"
                ? "bg-emerald-400 shadow-[0_0_8px_rgba(16,185,129,0.7)]"
                : status === "offline"
                ? "bg-amber-400"
                : "bg-muted-foreground/50 animate-pulse"
            )}
          />
          <span className="font-medium text-foreground/80">{LABEL[status]}</span>
        </div>
      </div>
    </header>
  );
}
