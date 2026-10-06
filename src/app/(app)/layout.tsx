import { Suspense } from "react";
import { AppSidebar, AppSidebarSkeleton } from "@/components/app/app-sidebar";
import { SiteHeader } from "@/components/app/site-header";
import { type ClientProfile, ProfileProvider } from "@/components/providers/profile-provider";
import { RealtimeProvider } from "@/components/providers/realtime-provider";
import { StagesProvider } from "@/components/providers/stages-provider";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { requireProfile } from "@/lib/auth";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const profile = getClientProfile();
  return (
    <ProfileProvider profile={profile}>
      <RealtimeProvider>
        <StagesProvider>
          <SidebarProvider>
            <Suspense fallback={<AppSidebarSkeleton />}>
              <AppSidebar />
            </Suspense>
            <SidebarInset>
              <SiteHeader />
              <div className="w-full flex-1 px-4 pt-4 pb-12 sm:px-6 lg:px-8">{children}</div>
            </SidebarInset>
          </SidebarProvider>
        </StagesProvider>
      </RealtimeProvider>
    </ProfileProvider>
  );
}

async function getClientProfile(): Promise<ClientProfile> {
  const { id, username, display_name, role, isSuperAdmin, company, companies } = await requireProfile();
  return { id, username, display_name, role, isSuperAdmin, company, companies };
}
