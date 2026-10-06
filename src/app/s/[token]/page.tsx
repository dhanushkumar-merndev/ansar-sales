import type { Metadata } from "next";
import { after } from "next/server";
import { headers } from "next/headers";
import { Download, ExternalLink, FileText, Link2Off } from "lucide-react";
import { BRAND_NAME, BrandMark, BrandName } from "@/components/app/brand";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { publicEnv } from "@/lib/env";
import { describeDevice, PREVIEW_BOT_RE } from "@/lib/device";
import { formatBytes, isImageMime } from "@/lib/library";
import { createAnonClient } from "@/lib/supabase/anon";
import { formatDate, formatDateTime } from "@/lib/time";
import { notifyShareOpened } from "@/server/share-notify";

export const metadata: Metadata = {
  // WhatsApp needs absolute preview-image URLs.
  metadataBase: publicEnv.appUrl ? new URL(publicEnv.appUrl) : undefined,
  title: { absolute: `Documents from ${BRAND_NAME}` },
  description: `Brochures and documents shared with you by ${BRAND_NAME}.`,
  openGraph: { title: `Documents from ${BRAND_NAME}`, description: "Tap to view and download.", images: ["/android-chrome-512x512.png"] },
  referrer: "no-referrer",
};

const TOKEN_RE = /^[a-f0-9]{64}$/;

type SharedFile = { id: string; name: string; mime_type: string; size_bytes: number; has_preview?: boolean };
type Share = { shared_by: string | null; created_at: string; expires_at: string | null; notify_share_id: string | null; files: SharedFile[] };

async function loadShare(token: string): Promise<Share | null> {
  if (!TOKEN_RE.test(token)) return null;
  const ua = (await headers()).get("user-agent") ?? "";
  const { data, error } = await createAnonClient().rpc("open_lead_share", {
    p_token: token,
    p_count_view: !PREVIEW_BOT_RE.test(ua),
    p_device: describeDevice(ua) ?? undefined,
  });
  if (error) return null;
  const share = data as unknown as Share | null;
  // Telegram the owner after the response is sent, so the customer's page isn't slowed.
  const notifyId = share?.notify_share_id;
  if (notifyId) after(() => notifyShareOpened(notifyId));
  return share;
}

export default async function SharePage({ params }: PageProps<"/s/[token]">) {
  const { token } = await params;
  const share = await loadShare(token);

  return (
    <main className="min-h-svh bg-background text-foreground">
      <div className="mx-auto w-full max-w-2xl px-4 pt-8 pb-16">
        <header className="mb-6 flex items-center gap-3">
          <BrandMark size={40} />
          <BrandName className="text-lg font-semibold tracking-tight" />
        </header>

        {!share ? (
          <Card className="items-center gap-2 px-6 py-12 text-center">
            <Link2Off className="size-8 text-muted-foreground" aria-hidden />
            <h1 className="text-lg font-semibold">This link has expired or is no longer available</h1>
            <p className="max-w-sm text-sm text-muted-foreground">Please ask the person who sent it for a new link.</p>
          </Card>
        ) : (
          <>
            <div className="mb-5">
              <h1 className="text-2xl font-semibold tracking-tight">Your documents</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {share.shared_by ? `Shared by ${share.shared_by} · ` : ""}{formatDate(share.created_at)}
                {share.expires_at ? ` · Available until ${formatDateTime(share.expires_at)}` : ""}
              </p>
            </div>

            {!share.files.length ? (
              <Card className="px-6 py-10 text-center text-sm text-muted-foreground">These files are no longer available.</Card>
            ) : (
              <ul className="space-y-4">
                {share.files.map((f) => {
                  const href = `/s/${token}/f/${f.id}`;
                  const image = isImageMime(f.mime_type);
                  return (
                    <li key={f.id}>
                      <Card className="gap-0 overflow-hidden py-0">
                        {image ? (
                          <a href={href} target="_blank" rel="noopener noreferrer" className="block bg-muted/40">
                            {/* eslint-disable-next-line @next/next/no-img-element -- redirects to a short-lived signed URL */}
                            <img src={`${href}?preview=1`} alt={f.name} loading="lazy" className="max-h-[70vh] w-full object-contain" />
                          </a>
                        ) : f.has_preview ? (
                          <a href={href} target="_blank" rel="noopener noreferrer" className="relative block max-h-[60vh] overflow-hidden bg-white">
                            {/* eslint-disable-next-line @next/next/no-img-element -- page 1 preview via a short-lived signed URL */}
                            <img src={`${href}?thumb=1`} alt={`First page of ${f.name}`} loading="lazy" className="w-full object-contain object-top" />
                            <span className="absolute bottom-2 left-2 inline-flex items-center gap-1.5 rounded-md bg-black/75 px-2 py-1 text-xs font-medium text-white">
                              <FileText className="size-3.5" aria-hidden /> PDF · tap to open
                            </span>
                          </a>
                        ) : (
                          <a href={href} target="_blank" rel="noopener noreferrer" className="flex items-center justify-center gap-3 bg-muted/40 px-4 py-8 text-muted-foreground">
                            <FileText className="size-10 shrink-0" aria-hidden />
                            <span className="text-sm font-semibold tracking-wide">PDF document</span>
                          </a>
                        )}
                        <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                          <div className="min-w-0">
                            <p className="truncate font-medium" title={f.name}>{f.name}</p>
                            <p className="text-xs text-muted-foreground">{image ? "Image" : "PDF"} · {formatBytes(f.size_bytes)}</p>
                          </div>
                          <div className="flex gap-2">
                            <Button asChild variant="outline" className="flex-1 sm:flex-none">
                              <a href={href} target="_blank" rel="noopener noreferrer"><ExternalLink /> Open</a>
                            </Button>
                            <Button asChild className="flex-1 sm:flex-none">
                              <a href={`${href}?download=1`}><Download /> Download</a>
                            </Button>
                          </div>
                        </div>
                      </Card>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
        <footer className="mt-10 text-center text-xs text-muted-foreground">Sent to you by {BRAND_NAME}. Please don&apos;t forward this link.</footer>
      </div>
    </main>
  );
}
