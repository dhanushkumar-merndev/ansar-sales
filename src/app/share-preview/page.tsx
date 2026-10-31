import type { Metadata } from "next";
import { PreviewBar } from "@/components/share/preview-bar";
import { SharedDocuments, type SharedFile } from "@/components/share/shared-documents";
import { requireProfile } from "@/lib/auth";
import { isImageMime, SHARE_EXPIRY, type ShareExpiry } from "@/lib/library";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Preview of the shared documents", robots: { index: false, follow: false } };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXPIRY_MS: Record<ShareExpiry, number | null> = { "24h": 24 * 3600_000, "7d": 7 * 86400_000, "30d": 30 * 86400_000, never: null };

/**
 * Staff-only: the customer's documents page exactly as it will look, before anything is sent.
 * ?files=<ids in order>&lead=<id>&expiry=7d. Files are read with the user's own access (RLS); nothing is
 * recorded (no view, no alert, no timeline entry) and no link is created.
 */
export default async function SharePreviewPage({ searchParams }: PageProps<"/share-preview">) {
  const profile = await requireProfile(["admin", "sales"]);
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const ids = [...new Set(one(sp.files).split(",").filter((id) => UUID_RE.test(id)))].slice(0, 20);
  const leadId = UUID_RE.test(one(sp.lead)) ? one(sp.lead) : null;
  const expiry = (one(sp.expiry) in SHARE_EXPIRY ? one(sp.expiry) : "7d") as ShareExpiry;

  const supabase = await createClient();
  const [files, lead] = await Promise.all([
    ids.length
      ? supabase.from("library_files").select("id, name, mime_type, size_bytes, thumb_path").in("id", ids).is("archived_at", null)
      : Promise.resolve({ data: [] as { id: string; name: string; mime_type: string; size_bytes: number; thumb_path: string | null }[] }),
    leadId ? supabase.from("leads").select("name").eq("id", leadId).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const byId = new Map((files.data ?? []).map((f) => [f.id, f]));
  const shared: SharedFile[] = ids.flatMap((id) => {
    const f = byId.get(id);
    return f ? [{ id: f.id, name: f.name, mime_type: f.mime_type, size_bytes: Number(f.size_bytes), has_preview: !!f.thumb_path || isImageMime(f.mime_type) }] : [];
  });
  const now = new Date();
  const ms = EXPIRY_MS[expiry];
  const firstName = lead.data?.name.split(" ")[0];

  return (
    <SharedDocuments
      brand={{ name: profile.company.name, highlight: profile.company.brandHighlight, logoUrl: profile.company.logoUrl }}
      share={{ shared_by: profile.display_name, created_at: now.toISOString(), expires_at: ms ? new Date(now.getTime() + ms).toISOString() : null, files: shared }}
      fileHref={(f) => `/share-preview/f/${f.id}`}
      topBar={<PreviewBar who={firstName ?? "the customer"} />}
    />
  );
}
