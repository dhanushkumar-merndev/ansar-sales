/** Escapes LIKE wildcards so user input is matched literally (used with PostgREST ilike filters). */
export function escapeLike(value: string) {
  // PostgREST also treats * as a wildcard in like/ilike values, so drop it.
  return value.replace(/[\\%_]/g, (c) => `\\${c}`).replace(/\*/g, "");
}

export const MAX_SEARCH_LENGTH = 100;

export function cleanSearch(value: string | null | undefined) {
  const v = (value ?? "").replace(/\s+/g, " ").trim();
  return v.slice(0, MAX_SEARCH_LENGTH);
}
