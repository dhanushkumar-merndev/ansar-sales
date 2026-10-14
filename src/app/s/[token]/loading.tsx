import { Skeleton } from "@/components/ui/skeleton";

export default function ShareLoading() {
  return (
    <main className="min-h-svh bg-background">
      <div className="border-b border-border">
        <div className="mx-auto flex max-w-6xl items-center gap-2.5 px-4 py-3 sm:px-6">
          <Skeleton className="size-7 rounded-lg" />
          <Skeleton className="h-4 w-32" />
        </div>
      </div>
      <div className="mx-auto w-full max-w-6xl space-y-5 px-4 py-8 sm:px-6 sm:py-10">
        <div className="flex flex-col items-center gap-2 pb-3">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
        <div className="grid gap-5 lg:grid-cols-2">
          <Skeleton className="h-96 w-full rounded-xl" />
          <Skeleton className="h-96 w-full rounded-xl" />
        </div>
      </div>
    </main>
  );
}
