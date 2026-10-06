import { after, NextResponse, type NextRequest } from "next/server";
import { safeEqual } from "@/lib/telegram";
import { leadgenChanges, verifyMetaSignature } from "@/lib/meta";
import { ingestLeadgens, loadMetaSecrets } from "@/server/meta-ingest";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Meta's subscription check: echo the challenge when the verify token matches this company's. */
export async function GET(request: NextRequest, { params }: RouteContext<"/api/meta/webhook/[companyId]">) {
  const { companyId } = await params;
  const q = request.nextUrl.searchParams;
  if (!UUID_RE.test(companyId) || q.get("hub.mode") !== "subscribe") return new NextResponse(null, { status: 400 });
  const secrets = await loadMetaSecrets(companyId);
  if (!secrets || !safeEqual(q.get("hub.verify_token") ?? "", secrets.verify_token)) return new NextResponse(null, { status: 403 });
  return new NextResponse(q.get("hub.challenge") ?? "", { status: 200, headers: { "Content-Type": "text/plain" } });
}

/**
 * New leads for one company's Page. Only requests signed with that company's app secret are
 * accepted. Answers 200 at once (Meta retries slow or failed deliveries) and fetches the leads after.
 */
export async function POST(request: NextRequest, { params }: RouteContext<"/api/meta/webhook/[companyId]">) {
  const { companyId } = await params;
  if (!UUID_RE.test(companyId)) return new NextResponse(null, { status: 404 });
  const raw = await request.text();
  if (raw.length > 200_000) return new NextResponse(null, { status: 413 });
  const secrets = await loadMetaSecrets(companyId);
  if (!secrets) return new NextResponse(null, { status: 404 });
  if (!verifyMetaSignature(raw, request.headers.get("x-hub-signature-256"), secrets.app_secret)) return new NextResponse(null, { status: 401 });

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new NextResponse(null, { status: 400 });
  }
  // Only leads for this company's own Page.
  const changes = leadgenChanges(payload).filter((c) => !c.pageId || c.pageId === secrets.page_id);
  if (changes.length) after(() => ingestLeadgens(companyId, secrets, changes).then(() => undefined));
  return NextResponse.json({ ok: true });
}
