import { Skeleton } from "@/components/ui/skeleton";

export default function ShareLoading() {
  return (
    <main className="min-h-svh bg-background">
      <div className="mx-auto w-full max-w-2xl space-y-4 px-4 pt-8">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    </main>
  );
}
