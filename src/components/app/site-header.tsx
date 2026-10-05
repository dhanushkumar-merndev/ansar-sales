"use client";

import { useRealtime } from "@/components/providers/realtime-provider";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

const LABEL = { live: "Live", connecting: "Connecting…", offline: "Reconnecting…" } as const;

export function SiteHeader() {
  const { status } = useRealtime();
  return (
    <header className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur md:px-6">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
      <div className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground" role="status" aria-live="polite">
        <span className={cn("size-2 rounded-full", status === "live" ? "bg-success" : status === "offline" ? "bg-warning" : "bg-muted-foreground/40")} />
        {LABEL[status]}
      </div>
    </header>
  );
}
