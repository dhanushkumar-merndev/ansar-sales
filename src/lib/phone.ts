import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js/min";

export const DEFAULT_COUNTRY: CountryCode = "IN";

/** Validates a phone number (local numbers default to India) and returns display + E.164 forms. */
export function normalizePhone(raw: string, country: CountryCode = DEFAULT_COUNTRY) {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = parsePhoneNumberFromString(trimmed, country);
  if (!parsed || !parsed.isValid()) return null;
  return { e164: parsed.number as string, display: parsed.formatInternational() };
}
