"use client";

import { startTransition } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  CalendarClock, ChartColumn, ChevronsUpDown, ClipboardList, Contact, FolderKanban, FolderOpen, IndianRupee, LayoutDashboard, LogOut, MapPin, Megaphone, Settings, Users, UsersRound, Wallet, Workflow,
} from "lucide-react";
import { CompanySwitcher } from "@/components/app/company-switcher";
import { useProfile } from "@/components/providers/profile-provider";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { clearKeptQueries } from "@/hooks/use-live-query";
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarRail, useSidebar,
} from "@/components/ui/sidebar";
import { rolesLabel, SUPER_ADMIN_LABEL } from "@/lib/constants";
import { initials } from "@/lib/format";
import { type NavKey, navFor } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { signOut } from "@/server/actions/auth";

const ITEMS: Record<NavKey, { label: string; href: string; icon: React.ComponentType<{ className?: string }> }> = {
  dashboard: { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  "my-work": { label: "My work", href: "/my-work", icon: ClipboardList },
  team: { label: "Team", href: "/team", icon: UsersRound },
  leads: { label: "Leads", href: "/leads", icon: Contact },
  "follow-ups": { label: "Follow-ups", href: "/follow-ups", icon: CalendarClock },
  projects: { label: "Projects", href: "/projects", icon: FolderKanban },
  "site-visits": { label: "Site visits", href: "/site-visits", icon: MapPin },
  payments: { label: "Payments", href: "/payments", icon: IndianRupee },
  library: { label: "Library", href: "/library", icon: FolderOpen },
  finance: { label: "Finance", href: "/finance", icon: Wallet },
  reports: { label: "Reports", href: "/reports", icon: ChartColumn },
  ads: { label: "Ads", href: "/ads", icon: Megaphone },
  "ad-results": { label: "Ad results", href: "/ad-results", icon: Megaphone },
  automation: { label: "Automation", href: "/automation", icon: Workflow },
  users: { label: "Users", href: "/users", icon: Users },
};

export function AppSidebar() {
  const pathname = usePathname();
  const profile = useProfile();
  const nav = navFor(profile.roles, profile.features);
  const { state, setOpen, setOpenMobile } = useSidebar();
  const isCollapsed = state === "collapsed";

  return (
    <Sidebar collapsible="icon" className="border-r-0">
      <SidebarHeader>
        <CompanySwitcher />
      </SidebarHeader>
      <SidebarContent className={cn("flex flex-col", isCollapsed && "cursor-pointer")}>
        <SidebarGroup className="flex-1 flex flex-col min-h-0">
          <SidebarGroupContent className="flex-1 flex flex-col min-h-0">
            <SidebarMenu>
              {nav.map((key) => {
                const item = ITEMS[key];
                const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                return (
                  <SidebarMenuItem key={key}>
                    <SidebarMenuButton asChild isActive={active} tooltip={item.label} className="h-9 rounded-lg text-[14px] data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium">
                      <Link href={item.href} onClick={() => setOpenMobile(false)}>
                        <item.icon />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
            {isCollapsed ? (
              <div
                onClick={() => setOpen(true)}
                className="flex-1 min-h-16 w-full cursor-pointer hover:bg-white/[0.04] transition-colors rounded-lg my-1"
                title="Click to expand sidebar"
                aria-label="Click to expand sidebar"
              />
            ) : null}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton size="lg" className="data-[state=open]:bg-sidebar-accent">
                  <Avatar className="size-8 rounded-lg">
                    <AvatarFallback className="rounded-lg">{initials(profile.display_name)}</AvatarFallback>
                  </Avatar>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-medium">{profile.display_name}</span>
                    <span className="truncate text-xs text-muted-foreground">@{profile.username}</span>
                  </div>
                  <ChevronsUpDown className="ml-auto size-4" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="w-56">
                <DropdownMenuLabel className="font-normal">
                  <div className="text-sm font-medium">{profile.display_name}</div>
                  <div className="text-xs text-muted-foreground">{profile.isSuperAdmin ? SUPER_ADMIN_LABEL : rolesLabel(profile.roles, profile.features)}</div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href="/settings"><Settings /> Settings</Link>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => { clearKeptQueries(); startTransition(() => signOut()); }}>
                  <LogOut /> Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

export function AppSidebarSkeleton() {
  return (
    <Sidebar collapsible="icon" className="border-r-0">
      <SidebarHeader>
        <Skeleton className="h-12 w-full rounded-lg" />
      </SidebarHeader>
      <SidebarContent className="gap-1 px-2 py-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-full rounded-lg" />
        ))}
      </SidebarContent>
      <SidebarFooter>
        <Skeleton className="h-12 w-full rounded-lg" />
      </SidebarFooter>
    </Sidebar>
  );
}
