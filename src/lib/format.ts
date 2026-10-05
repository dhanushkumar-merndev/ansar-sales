const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2, minimumFractionDigits: 2 });
const inrCompact = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", notation: "compact", maximumFractionDigits: 1 });
const integer = new Intl.NumberFormat("en-IN");

export const formatINR = (value: number | string | null | undefined) => inr.format(Number(value ?? 0));
export const formatINRCompact = (value: number | string | null | undefined) => inrCompact.format(Number(value ?? 0));
export const formatCount = (value: number | null | undefined) => integer.format(value ?? 0);

export function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("") || "?";
}
