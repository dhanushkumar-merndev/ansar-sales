"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Check, ChevronsUpDown, Loader2, Plus, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { BrandMark, BrandName } from "@/components/app/brand";
import { CompanyDialog } from "@/components/app/company-dialog";
import { useProfile } from "@/components/providers/profile-provider";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "@/components/ui/sidebar";
import { homePathFor, ROLE_LABELS, SUPER_ADMIN_LABEL } from "@/lib/constants";
import { switchCompany } from "@/server/actions/companies";

/**
 * Top-left brand. Everyone sees their company; the super admin (any company) and ads managers
 * (their assigned companies) switch company here.
 * A switch reloads the app: every list, cache and Realtime channel then belongs to the new company.
 */
export function CompanySwitcher() {
  const profile = useProfile();
  const { isMobile, setOpenMobile } = useSidebar();
  const [adding, setAdding] = useState(false);
  const [pending, startTransition] = useTransition();
  const { company } = profile;
  const canSwitch = profile.isSuperAdmin || profile.companies.length > 1;
  const home = homePathFor(profile.role);

  const brand = (
    <>
      <BrandMark size={32} logoUrl={company.logoUrl} />
      <div className="grid flex-1 text-left leading-tight">
        <BrandName name={company.name} highlight={company.brandHighlight} className="truncate text-[13px] font-semibold" />
        <span className="truncate text-[11px] text-muted-foreground">
          {profile.isSuperAdmin ? `${SUPER_ADMIN_LABEL} · switch company`
            : canSwitch ? `${ROLE_LABELS[profile.role]} · switch company` : `${ROLE_LABELS[profile.role]} workspace`}
        </span>
      </div>
    </>
  );

  if (!canSwitch) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton size="lg" asChild>
            <Link href={home} onClick={() => setOpenMobile(false)}>{brand}</Link>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }

  const go = (id: string) => {
    if (id === company.id) return;
    startTransition(async () => {
      const res = await switchCompany({ id });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      // A full load: every list, cache and Realtime channel then belongs to the new company.
      window.location.assign(home);
    });
  };

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" className="data-[state=open]:bg-sidebar-accent" disabled={pending}>
              {brand}
              {pending ? <Loader2 className="ml-auto size-4 animate-spin" /> : <ChevronsUpDown className="ml-auto size-4" />}
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-64" align="start" side={isMobile ? "bottom" : "right"} sideOffset={4}>
            <DropdownMenuLabel className="text-xs text-muted-foreground">Companies</DropdownMenuLabel>
            {profile.companies.map((c) => (
              <DropdownMenuItem key={c.id} onSelect={() => go(c.id)} className="gap-2 py-2">
                <BrandMark size={22} logoUrl={c.logoUrl} />
                <span className="flex-1 truncate">{c.name}</span>
                {c.id === company.id ? <Check className="size-4" aria-label="Current company" /> : null}
              </DropdownMenuItem>
            ))}
            {profile.isSuperAdmin ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setAdding(true)} className="gap-2">
                  <Plus /> Add company
                </DropdownMenuItem>
                <DropdownMenuItem asChild className="gap-2">
                  <Link href="/super" onClick={() => setOpenMobile(false)}><ShieldCheck /> Super settings</Link>
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
        {profile.isSuperAdmin ? <CompanyDialog open={adding} onOpenChange={setAdding} onSaved={go} /> : null}
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
