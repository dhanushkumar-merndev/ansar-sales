"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CalendarClock, ChevronsUpDown, LayoutDashboard, LogOut, Settings, Users, Wallet, Contact } from "lucide-react";
import { useProfile } from "@/components/providers/profile-provider";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar,
} from "@/components/ui/sidebar";
import { ROLE_LABELS } from "@/lib/constants";
import { initials } from "@/lib/format";
import type { NavKey } from "@/lib/permissions";
import { signOut } from "@/server/actions/auth";

const ITEMS: Record<NavKey, { label: string; href: string; icon: React.ComponentType<{ className?: string }> }> = {
  dashboard: { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  leads: { label: "Leads", href: "/leads", icon: Contact },
  "follow-ups": { label: "Follow-ups", href: "/follow-ups", icon: CalendarClock },
  finance: { label: "Finance", href: "/finance", icon: Wallet },
  users: { label: "Users", href: "/users", icon: Users },
  settings: { label: "Settings", href: "/settings", icon: Settings },
};

export function AppSidebar({ nav }: { nav: NavKey[] }) {
  const pathname = usePathname();
  const profile = useProfile();
  const { setOpenMobile } = useSidebar();

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link href="/dashboard" onClick={() => setOpenMobile(false)}>
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary font-semibold text-primary-foreground">C</div>
                <div className="grid flex-1 text-left leading-tight">
                  <span className="truncate font-semibold">CRM</span>
                  <span className="truncate text-xs text-muted-foreground">{ROLE_LABELS[profile.role]} workspace</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {nav.map((key) => {
                const item = ITEMS[key];
                const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                return (
                  <SidebarMenuItem key={key}>
                    <SidebarMenuButton asChild isActive={active} tooltip={item.label}>
                      <Link href={item.href} onClick={() => setOpenMobile(false)}>
                        <item.icon />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
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
                  <div className="text-xs text-muted-foreground">{ROLE_LABELS[profile.role]}</div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href="/settings"><Settings /> Settings</Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <form action={signOut} className="w-full">
                    <button type="submit" className="flex w-full items-center gap-2"><LogOut className="size-4" /> Sign out</button>
                  </form>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
