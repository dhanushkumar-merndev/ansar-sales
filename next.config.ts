import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), browsing-topics=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000" },
];

const nextConfig: NextConfig = {
  // Explicit caching model: only functions marked "use cache" are cached (niche options).
  cacheComponents: true,
  poweredByHeader: false,
  experimental: {
    // The browser keeps a visited page for 30 s and a page preloaded on hover for 60 s, so going back
    // to it needs no server round trip. Per user and in the browser only; the lists on it still refresh
    // themselves (useLiveQuery: Realtime, focus, a server read older than 10 s is read again).
    staleTimes: { dynamic: 30, static: 60 },
    // Lets <Link unstable_dynamicOnHover> preload the whole page, data included, on hover or touch.
    dynamicOnHover: true,
  },
  // The Facebook setup guide page reads this file at runtime.
  outputFileTracingIncludes: { "/help/meta-lead-ads": ["./docs/meta-lead-ads.md"] },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
