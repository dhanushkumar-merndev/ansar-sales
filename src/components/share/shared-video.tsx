"use client";

import { useRef } from "react";

/**
 * A shared video, played straight from storage: the browser fetches only the parts it needs
 * (range requests), so a 200 MB file starts in a moment and jumping ahead loads just that part.
 * The first play is counted once (pingHref) instead of every range request.
 */
export function SharedVideo({ src, poster, pingHref, label }: { src: string; poster?: string; pingHref: string; label: string }) {
  const counted = useRef(false);
  return (
    <video
      src={src}
      poster={poster}
      controls
      playsInline
      preload="metadata"
      aria-label={label}
      className="max-h-[480px] w-full bg-black"
      onPlay={() => {
        if (counted.current) return;
        counted.current = true;
        void fetch(pingHref, { cache: "no-store", keepalive: true }).catch(() => {});
      }}
    >
      Your browser can&apos;t play this video. Use Download instead.
    </video>
  );
}
