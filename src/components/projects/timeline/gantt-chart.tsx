"use client";

import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/skeleton";

/** Lazily loaded: ECharts (and its custom series) only ship when a timeline is opened. */
export const GanttChart = dynamic(() => import("./gantt-impl"), {
  ssr: false,
  loading: () => <Skeleton className="h-[320px] w-full" />,
});
