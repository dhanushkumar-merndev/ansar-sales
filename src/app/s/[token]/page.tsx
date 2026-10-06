import type { Metadata } from "next";
import { after } from "next/server";
import { headers } from "next/headers";
import { cache } from "react";
import { Download, ExternalLink, FileText, Link2Off, ShieldCheck } from "lucide-react";
import { BRAND_NAME, BrandMark, BrandName } from "@/components/app/brand";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { companyLogoUrl } from "@/lib/companies";
import { publicEnv } from "@/lib/env";
import { describeDevice, PREVIEW_BOT_RE } from "@/lib/device";
import { formatBytes, isImageMime } from "@/lib/library";
import { createAnonClient } from "@/lib/supabase/anon";
import { formatDate, formatDateTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { notifyShareOpened } from "@/server/share-notify";

const TOKEN_RE = /^[a-f0-9]{64}$/;

type Brand = { name: string; highlight: string | null; logoUrl: string | null };

/** Clean raw internal UUID or hash prefixes for customer-facing display */
function cleanFileName(name: string) {
  return name.replace(/^[a-f0-9]{8,}(-[a-f0-9]{4}){0,4}-/i, "");
}

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
    <main className="relative min-h-svh bg-[#141414] text-foreground flex flex-col justify-between selection:bg-white/20 selection:text-white">
      {/* Background ambient lighting */}
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-10%,rgba(120,119,198,0.12),transparent)]" />

      {/* Top Navbar */}
      <header className="sticky top-0 z-30 border-b border-white/[0.08] bg-[#1a1a1a]/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2.5">
            <BrandMark size={32} logoUrl={brand.logoUrl} />
            <BrandName name={brand.name} highlight={brand.highlight} className="text-sm font-semibold tracking-tight text-white" />
          </div>
          <div className="flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-400">
            <ShieldCheck className="size-3.5" />
            <span>Verified document link</span>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <div className="relative z-10 mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6">
        {!share ? (
          <Card className="items-center gap-3 border-white/[0.08] bg-[#1c1c1c] px-6 py-16 text-center">
            <div className="flex size-14 items-center justify-center rounded-2xl border border-white/[0.08] bg-white/[0.04] text-muted-foreground">
              <Link2Off className="size-6 text-zinc-400" aria-hidden />
            </div>
            <h1 className="text-lg font-semibold text-white">This link has expired or is no longer available</h1>
            <p className="max-w-sm text-sm text-muted-foreground">Please ask the person who shared it to provide a new link.</p>
          </Card>
        ) : (
          <>
            {/* Header info */}
            <div className="mb-6 text-center">
              <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">Shared Documents</h1>
              <p className="mt-1.5 text-xs text-muted-foreground sm:text-sm">
                {share.shared_by ? `Shared by ${share.shared_by} · ` : ""}
                {formatDate(share.created_at)}
                {share.expires_at ? ` · Available until ${formatDateTime(share.expires_at)}` : ""}
              </p>
            </div>

            {!share.files.length ? (
              <Card className="border-white/[0.08] bg-[#1c1c1c] px-6 py-12 text-center text-sm text-muted-foreground">
                These files are no longer available.
              </Card>
            ) : (
              <div className="space-y-6">
                {share.files.map((f) => {
                  const href = `/s/${token}/f/${f.id}`;
                  const image = isImageMime(f.mime_type);
                  const pdf = f.mime_type === "application/pdf";
                  const displayName = cleanFileName(f.name);

                  return (
                    <div
                      key={f.id}
                      className="overflow-hidden rounded-2xl border border-white/[0.1] bg-[#1e1e1e] shadow-2xl shadow-black/80 transition-all duration-200"
                    >
                      {/* Top Document Toolbar */}
                      <div className="flex flex-col gap-3 border-b border-white/[0.08] bg-[#242424] px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                        <div className="flex min-w-0 items-center gap-3">
                          <div
                            className={cn(
                              "flex size-9 shrink-0 items-center justify-center rounded-lg border text-[11px] font-bold tracking-wider uppercase",
                              pdf
                                ? "border-red-500/30 bg-red-500/10 text-red-400"
                                : "border-sky-500/30 bg-sky-500/10 text-sky-400",
                            )}
                          >
                            {pdf ? "PDF" : "IMG"}
                          </div>
                          <div className="min-w-0">
                            <h2 className="truncate text-sm font-semibold text-white sm:text-base" title={f.name}>
                              {displayName}
                            </h2>
                            <p className="text-[11px] text-zinc-400">
                              {formatBytes(f.size_bytes)} · {pdf ? "PDF Document" : "Image File"}
                            </p>
                          </div>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          <Button
                            asChild
                            variant="outline"
                            size="sm"
                            className="h-8.5 gap-1.5 rounded-lg border-white/10 bg-white/[0.05] text-xs font-medium text-zinc-200 hover:bg-white/10 hover:text-white"
                          >
                            <a href={href} target="_blank" rel="noopener noreferrer">
                              <ExternalLink className="size-3.5" />
                              <span>Open in new tab</span>
                            </a>
                          </Button>
                          <Button
                            asChild
                            size="sm"
                            className="h-8.5 gap-1.5 rounded-lg bg-white text-xs font-medium text-black hover:bg-zinc-200"
                          >
                            <a href={`${href}?download=1`}>
                              <Download className="size-3.5" />
                              <span>Download</span>
                            </a>
                          </Button>
                        </div>
                      </div>

                      {/* Document Viewer Desk / Stage */}
                      <div className="relative flex items-center justify-center overflow-hidden bg-[#121212] p-4 sm:p-8">
                        {/* Subtle dot pattern background for document canvas */}
                        <div className="pointer-events-none absolute inset-0 opacity-20 [background-image:radial-gradient(#ffffff_1px,transparent_1px)] [background-size:16px_16px]" />

                        {image ? (
                          <a
                            href={href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="group relative max-w-xl w-full overflow-hidden rounded-xl bg-black/60 shadow-2xl ring-1 ring-white/10 transition-transform duration-200 hover:scale-[1.01]"
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element -- redirects to short-lived signed URL */}
                            <img
                              src={`${href}?preview=1`}
                              alt={f.name}
                              loading="lazy"
                              className="max-h-[500px] w-full object-contain block mx-auto"
                            />
                            <div className="absolute inset-x-0 bottom-0 flex items-center justify-center bg-gradient-to-t from-black/80 to-transparent p-4 opacity-0 transition-opacity group-hover:opacity-100">
                              <span className="flex items-center gap-1.5 rounded-full border border-white/20 bg-white/20 px-3 py-1.5 text-xs font-medium text-white backdrop-blur-md shadow-lg">
                                <ExternalLink className="size-3.5" /> Click to view full image
                              </span>
                            </div>
                          </a>
                        ) : f.has_preview ? (
                          <a
                            href={href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="group relative max-w-md w-full overflow-hidden rounded-lg bg-white shadow-2xl ring-1 ring-white/10 transition-transform duration-200 hover:scale-[1.01]"
                          >
                            {/* Paper sheet preview with realistic shadow */}
                            {/* eslint-disable-next-line @next/next/no-img-element -- page 1 preview via short-lived signed URL */}
                            <img
                              src={`${href}?thumb=1`}
                              alt={`First page of ${f.name}`}
                              loading="lazy"
                              className="w-full h-auto object-contain object-top block"
                            />
                            {/* Floating bottom overlay bar */}
                            <div className="absolute inset-x-0 bottom-0 flex items-center justify-center bg-gradient-to-t from-black/85 via-black/40 to-transparent p-4 transition-all">
                              <span className="flex items-center gap-1.5 rounded-full border border-white/20 bg-black/75 px-3 py-1.5 text-xs font-medium text-white backdrop-blur-md shadow-lg transition-transform group-hover:scale-105">
                                <FileText className="size-3.5 text-zinc-300" />
                                <span>Tap anywhere to open full document</span>
                              </span>
                            </div>
                          </a>
                        ) : (
                          <a
                            href={href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex flex-col items-center justify-center gap-3 py-12 text-center text-muted-foreground hover:text-white"
                          >
                            <div className="flex size-14 items-center justify-center rounded-2xl border border-white/[0.08] bg-white/[0.04] text-zinc-300">
                              <FileText className="size-7" />
                            </div>
                            <div>
                              <p className="text-sm font-medium text-white">{displayName}</p>
                              <p className="text-xs text-zinc-400 mt-0.5">{formatBytes(f.size_bytes)} · PDF Document</p>
                            </div>
                          </a>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>

      {/* Footer */}
      <footer className="relative z-10 border-t border-white/[0.06] bg-[#141414] py-6 text-center text-xs text-zinc-500">
        <p>Sent to you securely by {brand.name}. Single-use private link.</p>
      </footer>
    </main>
  );
}
