import { DEFAULT_PAGE_SIZE, PAGE_SIZES } from "@/lib/constants";

export type PageResult<T> = { items: T[]; page: number; pageSize: number; total: number; hasNextPage: boolean };

const MAX_PAGE = 50_000;

/** Parses one-based page + allowlisted page size from URL params. Invalid input falls back to defaults. */
export function parsePaging(params: { get(name: string): string | null }) {
  const rawPage = params.get("page");
  const rawSize = params.get("pageSize");
  const page = rawPage && /^\d{1,6}$/.test(rawPage) ? Math.min(Math.max(Number(rawPage), 1), MAX_PAGE) : 1;
  const size = Number(rawSize);
  const pageSize = (PAGE_SIZES as readonly number[]).includes(size) ? size : DEFAULT_PAGE_SIZE;
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export function toPageResult<T>(items: T[], total: number, page: number, pageSize: number): PageResult<T> {
  return { items, page, pageSize, total, hasNextPage: page * pageSize < total };
}

export function lastPage(total: number, pageSize: number) {
  return Math.max(1, Math.ceil(total / pageSize));
}

/** Supabase .range() is inclusive on both ends. */
export function rangeFor(page: number, pageSize: number): [number, number] {
  const from = (page - 1) * pageSize;
  return [from, from + pageSize - 1];
}
