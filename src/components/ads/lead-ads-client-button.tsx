"use client";

import Link from "next/link";
import { Megaphone } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { useProfile } from "@/components/providers/profile-provider";
import { Button } from "@/components/ui/button";
import { useLiveQuery } from "@/hooks/use-live-query";
import { can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/client";
import { addLeadAsAdsClient } from "@/server/actions/ads";

/**
 * On a lead of a company with ads (admins, ads managers, super admin): "Add as client" hands it to
 * the ads team without marking it Won; once it is a client, the button opens the client instead.
 */
export function LeadAdsClientButton({ leadId, leadName, onChanged }: { leadId: string; leadName: string; onChanged: () => void }) {
  const me = useProfile();
  // A super admin counts as admin here.
  const allowed = can.useAds(me.roles) && !me.features.includes("no_ads") && !me.workspace;
  const client = useLiveQuery({
    queryKey: `lead-ads-client:${me.id}:${me.company.id}:${leadId}`,
    fetcher: async (signal) => {
      const { data, error } = await createClient().rpc("lead_ads_client", { p_lead_id: leadId }).abortSignal(signal);
      if (error) throw error;
      return data as { id: string; deleted: boolean } | null;
    },
    // Marking the lead Won can also create the client.
    tables: ["leads"],
    enabled: allowed,
  });
  if (!allowed || client.data === undefined) return null;

  if (client.data && !client.data.deleted) {
    return <Button variant="outline" asChild><Link href={`/ads/clients/${client.data.id}`}><Megaphone /> Ads client</Link></Button>;
  }
  // A deleted client is restored from Ads → Clients → Deleted, not re-created here.
  if (client.data?.deleted) return null;

  return (
    <ConfirmDialog
      trigger={<Button variant="outline"><Megaphone /> Add as client</Button>}
      title={`Add ${leadName} as an ads client?`}
      description="They appear in Ads → Clients for the ads team, with this lead's contact details. The lead itself stays as it is: it isn't marked Won."
      confirmLabel="Add as client"
      onConfirm={async () => {
        const r = await addLeadAsAdsClient({ leadId });
        if (!r.ok) { toast.error(r.error); return false; }
        toast.success(`${leadName} is now an ads client`);
        client.refetch();
        onChanged();
      }}
    />
  );
}
