"use client";

import "leaflet/dist/leaflet.css";
import { useEffect } from "react";
import { Circle, CircleMarker, MapContainer, Polyline, TileLayer, Tooltip, useMap } from "react-leaflet";
import type { LatLngBoundsExpression } from "leaflet";

type Point = { lat: number; lng: number };

function Fit({ points }: { points: Point[] }) {
  const map = useMap();
  useEffect(() => {
    if (points.length === 1) map.setView([points[0].lat, points[0].lng], 17);
    else if (points.length > 1) map.fitBounds(points.map((p) => [p.lat, p.lng]) as LatLngBoundsExpression, { padding: [32, 32], maxZoom: 18 });
  }, [map, points]);
  return null;
}

/** OpenStreetMap with the site pin (green) and the check-in position (blue, with its accuracy circle). */
export default function SiteMapImpl({ site, checkIn, height = 240 }: { site?: Point | null; checkIn?: (Point & { accuracy?: number | null }) | null; height?: number }) {
  const points = [site, checkIn].filter(Boolean) as Point[];
  const center = points[0] ?? { lat: 12.9716, lng: 77.5946 };
  return (
    <div className="overflow-hidden rounded-lg border" style={{ height }}>
      <MapContainer center={[center.lat, center.lng]} zoom={16} scrollWheelZoom={false} style={{ height: "100%", width: "100%" }} attributionControl>
        <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
        {site ? (
          <CircleMarker center={[site.lat, site.lng]} radius={9} pathOptions={{ color: "#065f46", fillColor: "#34d399", fillOpacity: 0.9, weight: 2 }}>
            <Tooltip permanent direction="top" offset={[0, -8]}>Site</Tooltip>
          </CircleMarker>
        ) : null}
        {checkIn ? (
          <>
            {checkIn.accuracy ? <Circle center={[checkIn.lat, checkIn.lng]} radius={checkIn.accuracy} pathOptions={{ color: "#60a5fa", weight: 1, fillOpacity: 0.12 }} /> : null}
            <CircleMarker center={[checkIn.lat, checkIn.lng]} radius={7} pathOptions={{ color: "#1e3a8a", fillColor: "#60a5fa", fillOpacity: 0.95, weight: 2 }}>
              <Tooltip direction="bottom" offset={[0, 8]}>Checked in here</Tooltip>
            </CircleMarker>
          </>
        ) : null}
        {site && checkIn ? <Polyline positions={[[site.lat, site.lng], [checkIn.lat, checkIn.lng]]} pathOptions={{ color: "#f87171", dashArray: "4 6", weight: 2 }} /> : null}
        <Fit points={points} />
      </MapContainer>
    </div>
  );
}
