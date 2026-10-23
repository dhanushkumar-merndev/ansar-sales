// The dashboards' default range and query keys, shared by the client dashboards and the server's first read.
import { addDays, istToday } from "@/lib/time";

export type DashRange = { from: string; to: string };

/** The last 30 IST days. */
export const defaultDashRange = (): DashRange => ({ from: addDays(istToday(), -29), to: istToday() });
export const dashKey = (kind: "admin" | "sales", userId: string, r: DashRange) => `dash-${kind}:${userId}:${r.from}:${r.to}`;
export const dashTasksKey = (view: "overdue" | "today", userId: string) => `dash-${view}:${userId}`;
export const DASH_TASKS_PAGE_SIZE = 5;
