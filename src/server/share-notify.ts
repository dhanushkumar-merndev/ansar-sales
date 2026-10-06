import "server-only";
import { publicEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Tells the lead's owner on Telegram that the customer opened the shared documents.
 * The database already limited this to the first open per IST day; failures are
 * ignored (the CRM timeline shows the open either way).
 */
export async function notifyShareOpened(shareId: string) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return;
  try {
    const admin = createAdminClient();
    const { data: share } = await admin
      .from("lead_shares")
      .select("lead:leads!lead_shares_lead_id_fkey(id, name, owner_id, archived_at)")
      .eq("id", shareId)
      .maybeSingle();
    const lead = (share as { lead: { id: string; name: string; owner_id: string; archived_at: string | null } | null } | null)?.lead;
    if (!lead || lead.archived_at) return;

    const [{ data: owner }, { data: conn }, { count }] = await Promise.all([
      admin.from("profiles").select("is_active").eq("id", lead.owner_id).maybeSingle(),
      admin.from("telegram_connections").select("chat_id, status").eq("user_id", lead.owner_id).maybeSingle(),
      admin.from("lead_share_files").select("file_id", { count: "exact", head: true }).eq("share_id", shareId).is("removed_at", null),
    ]);
    if (!owner?.is_active || !conn || conn.status !== "connected") return;

    const files = count ?? 0;
    const link = publicEnv.appUrl ? `\n${publicEnv.appUrl.replace(/\/+$/, "")}/leads/${lead.id}` : "";
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: conn.chat_id,
        text: `👀 ${lead.name} opened the documents you shared (${files} ${files === 1 ? "file" : "files"}).${link}`,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    // Best effort only.
  }
}
