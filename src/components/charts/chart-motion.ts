"use client";

import { createContext } from "react";

/**
 * Entry-animation timing for charts inside it (used by the Reports presentation): the chart waits
 * `delay` ms, then builds item by item. Outside a provider charts use ECharts' default animation.
 */
export const ChartMotion = createContext<{ delay: number } | null>(null);
