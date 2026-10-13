"use client";

import { useTransition } from "react";
import { ArrowLeft, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useProfile } from "@/components/providers/profile-provider";
import { Button } from "@/components/ui/button";
import { switchCompany } from "@/server/actions/companies";

/**
 * Shown inside an ads client's CRM: says whose CRM this is, and takes the agency's staff back to
 * the client's page. The client's own staff see the label only.
 */
export function WorkspaceBar() {
  const { company, workspace } = useProfile();
  const [pending, start] = useTransition();
  if (!workspace) return null;

  const back = () => start(async () => {
    const res = await switchCompany({ id: workspace.parentId });
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    // A full load: every list, cache and Realtime channel then belongs to the agency again.
    window.location.assign(workspace.adsClientId ? `/ads/clients/${workspace.adsClientId}` : "/ads/clients");
  });

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-white/[0.08] bg-card/60 px-4 py-2 text-sm sm:px-6 lg:px-8">
      <p className="min-w-0 text-muted-foreground">
        Working in <span className="font-medium text-foreground">{company.name}</span> · client CRM of {workspace.parentName}
      </p>
      {workspace.member ? null : (
        <Button variant="outline" size="sm" onClick={back} disabled={pending}>
          {pending ? <Loader2 className="animate-spin" /> : <ArrowLeft />} Back to {workspace.parentName}
        </Button>
      )}
    </div>
  );
}
