"use client";

import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/skeleton";

/** Leaflet needs the browser; load it only where a map is shown. */
export const SiteMap = dynamic(() => import("./site-map-impl"), { ssr: false, loading: () => <Skeleton className="h-60 w-full" /> });

/** "Open in Google Maps" link for a point. */
export const mapsUrl = (lat: number, lng: number) => `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
