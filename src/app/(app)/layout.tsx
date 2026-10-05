import { Suspense } from "react";
import { AppSidebar } from "@/components/app/app-sidebar";
import { SiteHeader } from "@/components/app/site-header";
import { ProfileProvider } from "@/components/providers/profile-provider";
import { RealtimeProvider } from "@/components/providers/realtime-provider";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { requireProfile } from "@/lib/auth";
import { navFor, realtimeTablesFor } from "@/lib/permissions";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<ShellSkeleton />}>
      <AuthedShell>{children}</AuthedShell>
    </Suspense>
  );
}

async function AuthedShell({ children }: { children: React.ReactNode }) {
  const profile = await requireProfile();
  const clientProfile = { id: profile.id, username: profile.username, display_name: profile.display_name, role: profile.role };
  return (
    <ProfileProvider profile={clientProfile}>
      {/* key: a different user gets fresh client state and subscriptions. */}
      <RealtimeProvider key={profile.id} userId={profile.id} tables={realtimeTablesFor(profile.role)}>
        <SidebarProvider>
          <AppSidebar nav={navFor(profile.role)} />
          <SidebarInset>
            <SiteHeader />
            <div className="mx-auto w-full max-w-7xl flex-1 px-4 py-5 md:px-6 md:py-6">{children}</div>
          </SidebarInset>
        </SidebarProvider>
      </RealtimeProvider>
    </ProfileProvider>
  );
}

function ShellSkeleton() {
  return (
    <div className="flex min-h-svh">
      <div className="hidden w-64 border-r bg-sidebar p-4 md:block">
        <Skeleton className="mb-6 h-8 w-32" />
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="mb-2 h-8 w-full" />
        ))}
      </div>
      <div className="flex-1 space-y-4 p-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    </div>
  );
}
