import { cn } from "@/lib/utils";

/**
 * A bounded list area that scrolls inside its card, so long histories never stretch the page.
 * Focusable and labelled so keyboard and screen-reader users can scroll it too.
 */
export function ScrollBox({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className={cn(
        "-mr-2 overflow-y-auto overscroll-contain rounded-md pr-2 [scrollbar-width:thin] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        className,
      )}
    >
      {children}
    </div>
  );
}
