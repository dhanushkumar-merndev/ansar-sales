import { NextResponse, type NextRequest } from "next/server";
import { describeDevice, PREVIEW_BOT_RE } from "@/lib/device";
import { LIBRARY_BUCKET } from "@/lib/library";
import { createAdminClient } from "@/lib/supabase/admin";
import { createAnonClient } from "@/lib/supabase/anon";

const TOKEN_RE = /^[a-f0-9]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIGNED_URL_SECONDS = 120;

const noStore = { "Cache-Control": "private, no-store" };

/**
 * Opens one file of a public share. The token is checked by the database on every
 * request; only then is a short-lived signed Storage URL minted and redirected to.
 */
export async function GET(request: NextRequest, { params }: RouteContext<"/s/[token]/f/[fileId]">) {
  const { token, fileId } = await params;
  if (!TOKEN_RE.test(token) || !UUID_RE.test(fileId)) return new NextResponse("Not found", { status: 404, headers: noStore });

  const search = request.nextUrl.searchParams;
  const download = search.get("download") === "1";
  // ?thumb=1: the small preview image (images fall back to themselves; PDFs without one → 404, the page shows an icon).
  const thumb = search.get("thumb") === "1";
  // Previews shown on the page are untracked; Open / Download are recorded in the lead's document timeline.
  const ua = request.headers.get("user-agent") ?? "";
  const tracked = !thumb && search.get("preview") !== "1" && !PREVIEW_BOT_RE.test(ua);

  const anon = createAnonClient();
  const { data, error } = tracked
    ? await anon.rpc("track_share_file", { p_token: token, p_file_id: fileId, p_kind: download ? "download" : "view", p_device: describeDevice(ua) ?? undefined })
    : await anon.rpc("resolve_share_file", { p_token: token, p_file_id: fileId });
  const file = data as { storage_path: string; thumb_path?: string | null; name: string; mime_type: string } | null;
  if (error || !file) return new NextResponse("This link has expired or is no longer available.", { status: 404, headers: noStore });

  const path = thumb ? (file.thumb_path ?? (file.mime_type.startsWith("image/") ? file.storage_path : null)) : file.storage_path;
  if (!path) return new NextResponse("No preview", { status: 404, headers: noStore });
  const { data: signed, error: signError } = await createAdminClient()
    .storage.from(LIBRARY_BUCKET)
    .createSignedUrl(path, SIGNED_URL_SECONDS, download && !thumb ? { download: file.name } : undefined);
  if (signError || !signed) return new NextResponse("Couldn't open the file. Please try again.", { status: 502, headers: noStore });

  return NextResponse.redirect(signed.signedUrl, { status: 302, headers: noStore });
}
