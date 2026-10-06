import Image from "next/image";
import { cn } from "@/lib/utils";

export const BRAND_NAME = "Star Growth Hub";

/** Visible brand wordmark: "Growth" in the brand red. Use BRAND_NAME for plain text (titles, messages). */
export function BrandName({ suffix, className }: { suffix?: string; className?: string }) {
  return (
    <span className={className}>
      Star <span className="text-red-500">Growth</span> Hub{suffix ? ` ${suffix}` : null}
    </span>
  );
}

/** Brand mark for the dark-only theme: the light-stroke logo directly on the dark surface. */
export function BrandMark({ size = 32, className, alt = "" }: { size?: number; className?: string; alt?: string }) {
  return <Image src="/logo-dark.png" alt={alt} width={size} height={size} className={cn("shrink-0", className)} priority />;
}
