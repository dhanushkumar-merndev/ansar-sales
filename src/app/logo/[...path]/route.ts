import { NextResponse } from "next/server";
import { presignGet } from "@/lib/storage";
import { LOGO_PATH_RE } from "@/lib/storage-paths";

const SIGNED_URL_SECONDS = 3600;

/**
 * Company logo from the private bucket. Logos are not sensitive (they appear on public share
 * pages), so no session is needed; the path pattern keeps this route to the logos/ prefix.
 * Browsers may reuse the redirect for 5 minutes, well inside the signed URL's lifetime.
 */
export async function GET(_request: Request, { params }: RouteContext<"/logo/[...path]">) {
  const path = (await params).path.join("/");
  if (!LOGO_PATH_RE.test(path)) return new NextResponse("Not found", { status: 404 });
  const url = await presignGet("logos", path, { expiresIn: SIGNED_URL_SECONDS });
  return NextResponse.redirect(url, { status: 302, headers: { "Cache-Control": "public, max-age=300" } });
}
