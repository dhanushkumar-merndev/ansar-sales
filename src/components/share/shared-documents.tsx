import type { ReactNode } from "react";
import { Download, ExternalLink, FileText, Film, ImageIcon, Link2Off, Lock } from "lucide-react";
import { BrandMark, BrandName } from "@/components/app/brand";
import { SharedVideo } from "@/components/share/shared-video";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatBytes, isImageMime, isVideoMime } from "@/lib/library";
import { formatDate, formatDateTime } from "@/lib/time";

export type ShareBrand = { name: string; highlight: string | null; logoUrl: string | null };
export type SharedFile = { id: string; name: string; mime_type: string; size_bytes: number; has_preview?: boolean };
export type SharedDocumentsData = { shared_by: string | null; created_at: string; expires_at: string | null; files: SharedFile[] };

/** Clean raw internal UUID or hash prefixes for customer-facing display */
function cleanFileName(name: string) {
  return name.replace(/^[a-f0-9]{8,}(-[a-f0-9]{4}){0,4}-/i, "");
}

/**
 * The customer's documents page (the public /s/<token> link), also used by the staff preview.
 * fileHref: where a file opens; "?download=1", "?thumb=1", "?preview=1" (untracked), "?stream=1"
 * (a video's long-lived untracked link) and "?ping=1" (counts a video play) are added to it.
 */
export function SharedDocuments({ brand, share, fileHref, topBar }: {
  brand: ShareBrand; share: SharedDocumentsData | null; fileHref: (file: SharedFile) => string; topBar?: ReactNode;
}) {
  return (
    <main className="flex min-h-svh flex-col bg-background text-foreground">
      {topBar}
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-2.5">
            <BrandMark size={28} logoUrl={brand.logoUrl} />
            <BrandName name={brand.name} highlight={brand.highlight} className="truncate text-sm font-semibold tracking-tight" />
          </div>
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            <Lock className="size-3.5" aria-hidden /> Private link
          </span>
        </div>
      </header>

      <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6 sm:py-10">
        {!share ? (
          <Card className="mx-auto max-w-3xl items-center gap-3 px-6 py-14 text-center">
            <IconTile><Link2Off className="size-5" aria-hidden /></IconTile>
            <h1 className="text-lg font-semibold">This link has expired or is no longer available</h1>
            <p className="max-w-sm text-sm text-muted-foreground">Please ask the person who shared it for a new link.</p>
          </Card>
        ) : (
          <>
            <div className="mb-8 text-center">
              <h1 className="text-2xl font-semibold tracking-tight sm:text-[28px]">Documents from {brand.name}</h1>
              <p className="mt-2 text-sm text-muted-foreground">
                {share.shared_by ? `Shared by ${share.shared_by} · ` : ""}
                {formatDate(share.created_at)}
                {share.expires_at ? ` · Available until ${formatDateTime(share.expires_at)}` : ""}
              </p>
            </div>

            {!share.files.length ? (
              <Card className="mx-auto max-w-3xl px-6 py-12 text-center text-sm text-muted-foreground">These files are no longer available.</Card>
            ) : (
              // Two per row on wide screens; a single file stays one centered card.
              <div className={share.files.length > 1 ? "grid gap-5 lg:grid-cols-2" : "mx-auto max-w-3xl"}>
                {share.files.map((f) => <FileCard key={f.id} file={f} href={fileHref(f)} />)}
              </div>
            )}
          </>
        )}
      </div>

      <footer className="border-t border-border py-6 text-center text-xs text-muted-foreground">
        Sent to you securely by {brand.name}. Private link.
      </footer>
    </main>
  );
}

function IconTile({ children }: { children: ReactNode }) {
  return (
    <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">{children}</div>
  );
}

function FileCard({ file: f, href }: { file: SharedFile; href: string }) {
  const image = isImageMime(f.mime_type);
  const video = isVideoMime(f.mime_type);
  const pdf = f.mime_type === "application/pdf";
  const displayName = cleanFileName(f.name);
  const kind = pdf ? "PDF" : image ? "Image" : video ? "Video" : "File";
  const Icon = image ? ImageIcon : video ? Film : FileText;

  return (
    <Card className="h-full gap-0 overflow-hidden p-0">
      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <IconTile><Icon className="size-5" aria-hidden /></IconTile>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-medium" title={displayName}>{displayName}</h2>
            <p className="text-xs text-muted-foreground">{formatBytes(f.size_bytes)} · {kind}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {video ? null : (
            <Button asChild variant="outline" size="sm" className="flex-1 sm:flex-none">
              <a href={href} target="_blank" rel="noopener noreferrer"><ExternalLink /> Open</a>
            </Button>
          )}
          <Button asChild size="sm" className="flex-1 sm:flex-none">
            <a href={`${href}?download=1`}><Download /> Download</a>
          </Button>
        </div>
      </div>

      {video ? (
        // Plays straight from storage in pieces (range requests): it starts at once, no full download first.
        <div className="flex flex-1 items-center justify-center border-t border-border bg-black">
          <SharedVideo src={`${href}?stream=1`} poster={f.has_preview ? `${href}?thumb=1` : undefined} pingHref={`${href}?ping=1`} label={displayName} />
        </div>
      ) : image || f.has_preview ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open ${displayName}`}
          className="group relative flex max-h-[420px] flex-1 justify-center overflow-hidden border-t border-border bg-muted/40 px-4 pt-4 sm:px-8 sm:pt-6"
        >
          {image ? (
            /* eslint-disable-next-line @next/next/no-img-element -- redirects to a short-lived signed URL */
            <img src={`${href}?preview=1`} alt={displayName} loading="lazy" className="mb-4 max-h-[380px] w-auto max-w-full rounded-lg object-contain sm:mb-6" />
          ) : (
            /* eslint-disable-next-line @next/next/no-img-element -- page 1 preview via a short-lived signed URL */
            <img src={`${href}?thumb=1`} alt={`First page of ${displayName}`} loading="lazy" className="h-auto w-full max-w-md rounded-t-lg bg-white object-contain object-top ring-1 ring-border" />
          )}
          {pdf ? (
            <span className="absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-card via-card/70 to-transparent px-4 pb-4 pt-16">
              <span className="flex items-center gap-1.5 rounded-full border border-border bg-background/90 px-3 py-1.5 text-xs font-medium text-foreground transition-colors group-hover:bg-accent">
                <FileText className="size-3.5" aria-hidden /> Tap to open the full document
              </span>
            </span>
          ) : null}
        </a>
      ) : (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="flex flex-1 items-center justify-center gap-2 border-t border-border bg-muted/40 py-10 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <FileText className="size-4" aria-hidden /> Open to view
        </a>
      )}
    </Card>
  );
}
