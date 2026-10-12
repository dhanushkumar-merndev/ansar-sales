// Free allowances: files on Tigris (5 GB standard storage, free egress; https://www.tigrisdata.com/pricing,
// checked 2026-10-07), database on Supabase Free (500 MB; https://supabase.com/pricing, checked 2026-10-05).
// Recheck before relying on them; plans and quotas change.
export const FREE_PLAN_LIMITS = {
  storageBytes: 5 * 1024 ** 3, // 5 GB Tigris file storage
  databaseBytes: 500 * 1024 ** 2, // 500 MB Supabase database
} as const;

export const USAGE_WARN_PERCENT = 80;

export function usagePercent(used: number, limit: number) {
  return limit > 0 ? Math.min(100, Math.round((used / limit) * 1000) / 10) : 0;
}

export type UsageSummary = {
  database_bytes: number; storage_bytes: number; storage_objects: number;
  library: { active_files: number; active_bytes: number; archived_files: number; archived_bytes: number; unregistered_files: number; unregistered_bytes: number };
  by_folder: { name: string; bytes: number; files: number }[];
  by_type: { pdf_bytes: number; image_bytes: number };
  shares: { active_links: number; total_opens: number };
};
