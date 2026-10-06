"use client";

import { useState } from "react";
import { Download, ExternalLink, Eye, EyeOff, FileText, ImageIcon, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatBytes, isImageMime } from "@/lib/library";
import { cn } from "@/lib/utils";

type SharedFile = {
  id: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  has_preview?: boolean;
};

export function ShareFileCard({ file, token }: { file: SharedFile; token: string }) {
  const href = `/s/${token}/f/${file.id}`;
  const isImage = isImageMime(file.mime_type);
  const isPdf = file.mime_type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  const [showPreview, setShowPreview] = useState(true);
  const [iframeError, setIframeError] = useState(false);

  return (
    <Card className="gap-0 overflow-hidden border border-white/[0.1] bg-[#262626] p-0 shadow-2xl transition-all rounded-2xl">
      {/* Card Header with details & action buttons */}
      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between border-b border-white/[0.08] bg-[#222222]/80 backdrop-blur-xs">
        <div className="flex items-center gap-3 min-w-0">
          <div
            className={cn(
              "flex size-10 shrink-0 items-center justify-center rounded-xl border shadow-xs",
              isPdf
                ? "border-rose-500/30 bg-rose-500/10 text-rose-400"
                : isImage
                ? "border-sky-500/30 bg-sky-500/10 text-sky-400"
                : "border-white/[0.12] bg-white/[0.06] text-muted-foreground"
            )}
          >
            {isPdf ? <FileText className="size-5" /> : isImage ? <ImageIcon className="size-5" /> : <FileText className="size-5" />}
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-foreground" title={file.name}>
              {file.name}
            </h2>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>{isPdf ? "PDF Document" : isImage ? "Image" : "Document"}</span>
              <span>•</span>
              <span>{formatBytes(file.size_bytes)}</span>
            </div>
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2 shrink-0">
          {isPdf ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setShowPreview((s) => !s)}
              className="text-xs text-muted-foreground hover:text-foreground hover:bg-white/[0.06] rounded-xl"
              title={showPreview ? "Hide preview" : "Show preview"}
            >
              {showPreview ? <><EyeOff className="size-3.5 mr-1.5" /> Hide</> : <><Eye className="size-3.5 mr-1.5" /> Preview</>}
            </Button>
          ) : null}
          <Button asChild variant="outline" size="sm" className="rounded-xl border-white/[0.12] hover:bg-white/[0.08] hover:text-foreground text-foreground">
            <a href={href} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="size-3.5 mr-1.5" /> Open
            </a>
          </Button>
          <Button asChild size="sm" className="rounded-xl bg-white text-black hover:bg-white/90 font-semibold shadow-xs">
            <a href={`${href}?download=1`}>
              <Download className="size-3.5 mr-1.5" /> Download
            </a>
          </Button>
        </div>
      </div>

      {/* Preview Area */}
      {isImage ? (
        <div className="relative overflow-hidden bg-black/40 flex items-center justify-center p-2 sm:p-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={href}
            alt={file.name}
            loading="lazy"
            className="max-h-[70vh] w-auto max-w-full rounded-lg object-contain shadow-md"
          />
        </div>
      ) : isPdf && showPreview && !iframeError ? (
        <div className="relative w-full overflow-hidden bg-[#181818] border-b border-white/[0.06]">
          {/* Live embedded PDF Viewer */}
          <div className="h-[480px] sm:h-[600px] w-full relative">
            <iframe
              src={`${href}#page=1&view=FitH&toolbar=0&navpanes=0`}
              title={`Preview of ${file.name}`}
              className="size-full border-0 bg-white"
              onError={() => setIframeError(true)}
              loading="lazy"
            />
          </div>

          {/* Bottom Floating Bar */}
          <div className="px-4 py-2 bg-[#1c1c1c] border-t border-white/[0.08] flex items-center justify-between text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <ShieldCheck className="size-3.5 text-emerald-400" />
              <span>Interactive First-Page Preview</span>
            </span>
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-foreground hover:underline flex items-center gap-1"
            >
              Open in full viewer <ExternalLink className="size-3" />
            </a>
          </div>
        </div>
      ) : isPdf && (!showPreview || iframeError) ? (
        <div className="flex flex-col items-center justify-center gap-2.5 py-12 px-4 bg-[#1e1e1e] text-center">
          <div className="flex size-12 items-center justify-center rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-400">
            <FileText className="size-6" />
          </div>
          <p className="text-sm font-medium text-foreground">{file.name}</p>
          <p className="text-xs text-muted-foreground max-w-xs">
            Preview is hidden. Tap below to view or download the full PDF document.
          </p>
          <div className="flex gap-2 mt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => { setIframeError(false); setShowPreview(true); }}
              className="rounded-xl text-xs border-white/[0.12]"
            >
              <Eye className="size-3.5 mr-1.5" /> Show preview
            </Button>
            <Button asChild size="sm" className="rounded-xl text-xs bg-white text-black font-semibold">
              <a href={href} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="size-3.5 mr-1.5" /> Open PDF
              </a>
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-center gap-3 bg-[#1e1e1e] px-4 py-10 text-muted-foreground">
          <FileText className="size-8 text-muted-foreground/60" />
          <span className="text-sm font-medium text-foreground/80">{file.name}</span>
        </div>
      )}
    </Card>
  );
}
