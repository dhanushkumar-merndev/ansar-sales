import { NextResponse, type NextRequest } from "next/server";
import { isVideoMime } from "@/lib/library";
import { presignGet } from "@/lib/storage";
import { createClient } from "@/lib/supabase/server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const noStore = { "Cache-Control": "private, no-store" };

/**
 * Files of the staff preview (/share-preview): like the customer's file route, but the signed-in user's
 * own access (RLS) decides instead of a share token, and nothing is ever recorded.
 */
export async function GET(request: NextRequest, { params }: RouteContext<"/share-preview/f/[fileId]">) {
  const { fileId } = await params;
  if (!UUID_RE.test(fileId)) return new NextResponse("Not found", { status: 404, headers: noStore });
  const search = request.nextUrl.searchParams;
  const supabase = await createClient();
  const { data: file } = await supabase.from("library_files").select("storage_path, thumb_path, name, mime_type").eq("id", fileId).is("archived_at", null).maybeSingle();
  if (!file) return new NextResponse("Not found", { status: 404, headers: noStore });
  if (search.get("ping") === "1") return new NextResponse(null, { status: 204, headers: noStore });

  const thumb = search.get("thumb") === "1";
  const download = search.get("download") === "1";
  const path = thumb ? (file.thumb_path ?? (file.mime_type.startsWith("image/") ? file.storage_path : null)) : file.storage_path;
  if (!path) return new NextResponse("No preview", { status: 404, headers: noStore });
  const expiresIn = search.get("stream") === "1" && !thumb && isVideoMime(file.mime_type) ? 6 * 60 * 60 : 120;
  try {
    const url = await presignGet("library", path, { expiresIn, downloadName: download && !thumb ? file.name : undefined });
    return NextResponse.redirect(url, { status: 302, headers: noStore });
  } catch {
    return new NextResponse("Couldn't open the file. Please try again.", { status: 502, headers: noStore });
  }
}
