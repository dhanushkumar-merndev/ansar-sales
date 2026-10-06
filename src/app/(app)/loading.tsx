import { Skeleton } from "@/components/ui/skeleton";

/** Instant page placeholder while a page reads the session (the shell above it stays mounted). */
export default function PageLoading() {
  return (
    <div className="space-y-4 pt-4">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
