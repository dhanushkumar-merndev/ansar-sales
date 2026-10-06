import Image from "next/image";
import { cn } from "@/lib/utils";

export const BRAND_NAME = "Star Growth Hub";
const DEFAULT_HIGHLIGHT = "Growth";

/**
 * Visible brand wordmark with one word in the brand red, e.g. Star <Growth> Hub.
 * Without arguments it is the platform brand; pass a company's name and highlight word for that company.
 */
export function BrandName({
  name = BRAND_NAME,
  highlight = name === BRAND_NAME ? DEFAULT_HIGHLIGHT : null,
  suffix,
  className,
}: { name?: string; highlight?: string | null; suffix?: string; className?: string }) {
  const at = highlight ? name.toLowerCase().indexOf(highlight.toLowerCase()) : -1;
  return (
    <span className={className}>
      {at < 0 ? name : (
        <>
          {name.slice(0, at)}
          <span className="text-red-500">{name.slice(at, at + highlight!.length)}</span>
          {name.slice(at + highlight!.length)}
        </>
      )}
      {suffix ? ` ${suffix}` : null}
    </span>
  );
}

/** Brand mark for the dark-only theme: the company logo when it has one, else the light-stroke default logo. */
export function BrandMark({ size = 32, className, alt = "", logoUrl }: { size?: number; className?: string; alt?: string; logoUrl?: string | null }) {
  if (logoUrl) {
    // Company logos come from Supabase Storage; a plain img avoids configuring remote image hosts.
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={logoUrl} alt={alt} width={size} height={size} className={cn("shrink-0 rounded-md object-contain", className)} style={{ width: size, height: size }} />;
  }
  return <Image src="/logo-dark.png" alt={alt} width={size} height={size} className={cn("shrink-0", className)} priority />;
}
