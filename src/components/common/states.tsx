"use client";

import { useEffect } from "react";
import { Inbox, Loader2, RotateCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2.5 rounded-2xl border border-dashed border-white/[0.1] bg-[#262626]/40 px-6 py-14 text-center">
      <div className="flex size-12 items-center justify-center rounded-xl bg-white/[0.04] border border-white/[0.06] text-muted-foreground/80 mb-1">
        <Inbox className="size-6" aria-hidden />
      </div>
      <p className="font-semibold text-foreground text-sm tracking-tight">{title}</p>
      {description ? <p className="max-w-sm text-xs text-muted-foreground leading-relaxed">{description}</p> : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}

/** A failed load: the message goes to a toast (once per message); the page keeps only a Retry button. */
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  useEffect(() => {
    toast.error(message, { id: `load-error:${message}` });
  }, [message]);
  if (!onRetry) return null;
  return (
    <div className="flex justify-center py-8">
      <Button variant="outline" size="sm" onClick={onRetry}>
        <RotateCw /> Retry
      </Button>
    </div>
  );
}

export function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  );
}

export function FetchingIndicator({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" role="status">
      <Loader2 className="size-3 animate-spin" /> Updating…
    </span>
  );
}
