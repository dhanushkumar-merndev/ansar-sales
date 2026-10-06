import type { Metadata } from "next";
import { after } from "next/server";
import { headers } from "next/headers";
import { cache } from "react";
import { Download, ExternalLink, FileText, Link2Off } from "lucide-react";
import { BRAND_NAME, BrandMark, BrandName } from "@/components/app/brand";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { companyLogoUrl } from "@/lib/companies";
import { publicEnv } from "@/lib/env";
import { describeDevice, PREVIEW_BOT_RE } from "@/lib/device";
import { formatBytes, isImageMime } from "@/lib/library";
import { createAnonClient } from "@/lib/supabase/anon";
import { formatDate, formatDateTime } from "@/lib/time";
import { notifyShareOpened } from "@/server/share-notify";

const TOKEN_RE = /^[a-f0-9]{64}$/;

type Brand = { name: string; highlight: string | null; logoUrl: string | null };

/** The lead's company, for the header and the link preview. Falls back to the platform brand. */
const loadBrand = cache(async (token: string): Promise<Brand> => {
  if (TOKEN_RE.test(token)) {
    const { data } = await createAnonClient().rpc("share_brand", { p_token: token });
    const b = data as { name: string; brand_highlight: string | null; logo_path: string | null } | null;
    if (b) return { name: b.name, highlight: b.brand_highlight, logoUrl: companyLogoUrl(b.logo_path) };
  }
  return { name: BRAND_NAME, highlight: null, logoUrl: null };
});

export async function generateMetadata({ params }: PageProps<"/s/[token]">): Promise<Metadata> {
  const { name } = await loadBrand((await params).token);
  return {
    // WhatsApp needs absolute preview-image URLs.
    metadataBase: publicEnv.appUrl ? new URL(publicEnv.appUrl) : undefined,
    title: { absolute: `Documents from ${name}` },
    description: `Brochures and documents shared with you by ${name}.`,
    openGraph: { title: `Documents from ${name}`, description: "Tap to view and download.", images: ["/android-chrome-512x512.png"] },
    referrer: "no-referrer",
  };
}

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
  const [share, brand] = await Promise.all([loadShare(token), loadBrand(token)]);

  return (
    <main className="min-h-svh bg-background text-foreground">
      <div className="mx-auto w-full max-w-lg px-4 pt-8 pb-16">
        <header className="mb-6 flex items-center gap-3">
          <BrandMark size={36} logoUrl={brand.logoUrl} />
          <BrandName name={brand.name} highlight={brand.highlight} className="text-base font-semibold tracking-tight" />
        </header>

        {!share ? (
          <Card className="items-center gap-2 px-6 py-12 text-center">
            <Link2Off className="size-8 text-muted-foreground" aria-hidden />
            <h1 className="text-lg font-semibold">This link has expired or is no longer available</h1>
            <p className="max-w-sm text-sm text-muted-foreground">Please ask the person who sent it for a new link.</p>
          </Card>
        ) : (
          <>
            <div className="mb-4">
              <h1 className="text-xl font-semibold tracking-tight">Your documents</h1>
              <p className="mt-1 text-xs text-muted-foreground">
                {share.shared_by ? `Shared by ${share.shared_by} · ` : ""}{formatDate(share.created_at)}
                {share.expires_at ? ` · Available until ${formatDateTime(share.expires_at)}` : ""}
              </p>
            </div>

            {!share.files.length ? (
              <Card className="px-6 py-10 text-center text-sm text-muted-foreground">These files are no longer available.</Card>
            ) : (
              <ul className="space-y-3.5">
                {share.files.map((f) => {
                  const href = `/s/${token}/f/${f.id}`;
                  const image = isImageMime(f.mime_type);
                  return (
                    <li key={f.id}>
                      <Card className="gap-0 overflow-hidden py-0 border-white/[0.08] bg-[#262626]">
                        {image ? (
                          <a href={href} target="_blank" rel="noopener noreferrer" className="flex h-44 sm:h-52 w-full items-center justify-center overflow-hidden bg-zinc-950/70 p-2">
                            {/* eslint-disable-next-line @next/next/no-img-element -- redirects to a short-lived signed URL */}
                            <img src={`${href}?preview=1`} alt={f.name} loading="lazy" className="max-h-full max-w-full rounded-md object-contain" />
                          </a>
                        ) : f.has_preview ? (
                          <a href={href} target="_blank" rel="noopener noreferrer" className="group relative flex h-44 sm:h-52 w-full items-center justify-center overflow-hidden bg-zinc-950/70 p-3">
                            <div className="relative flex max-h-full max-w-full items-center justify-center overflow-hidden rounded-md border border-white/10 bg-white shadow-md transition-transform duration-200 group-hover:scale-[1.02]">
                              {/* eslint-disable-next-line @next/next/no-img-element -- page 1 preview via a short-lived signed URL */}
                              <img src={`${href}?thumb=1`} alt={`First page of ${f.name}`} loading="lazy" className="max-h-36 sm:max-h-44 w-auto object-contain object-top" />
                            </div>
                            <span className="absolute bottom-2.5 left-2.5 inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-black/80 px-2 py-1 text-[11px] font-medium text-white backdrop-blur-xs">
                              <FileText className="size-3.5 text-zinc-300" aria-hidden /> PDF · tap to open
                            </span>
                          </a>
                        ) : (
                          <a href={href} target="_blank" rel="noopener noreferrer" className="flex h-28 w-full items-center justify-center gap-3 bg-zinc-900/50 px-4 text-muted-foreground hover:bg-zinc-900">
                            <div className="flex size-10 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.04] text-zinc-300">
                              <FileText className="size-5" aria-hidden />
                            </div>
                            <span className="text-sm font-medium text-foreground">PDF document</span>
                          </a>
                        )}
                        <div className="flex flex-col gap-3 p-3.5 sm:flex-row sm:items-center sm:justify-between">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-foreground" title={f.name}>{f.name}</p>
                            <p className="text-xs text-muted-foreground">{image ? "Image" : "PDF"} · {formatBytes(f.size_bytes)}</p>
                          </div>
                          <div className="flex gap-2 shrink-0">
                            <Button asChild variant="outline" size="sm" className="flex-1 sm:flex-none text-xs">
                              <a href={href} target="_blank" rel="noopener noreferrer"><ExternalLink className="size-3.5" /> Open</a>
                            </Button>
                            <Button asChild size="sm" className="flex-1 sm:flex-none text-xs">
                              <a href={`${href}?download=1`}><Download className="size-3.5" /> Download</a>
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
        <footer className="mt-8 text-center text-xs text-muted-foreground">Sent to you by {brand.name}. Please don&apos;t forward this link.</footer>
      </div>
    </main>
  );
}
