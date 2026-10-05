import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Explicit caching model: only functions marked "use cache" are cached (niche options).
  cacheComponents: true,
  poweredByHeader: false,
};

export default nextConfig;
