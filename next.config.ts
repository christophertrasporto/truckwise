import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // Lets the E2E build live beside a running dev server without clobbering its .next folder.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
};

export default nextConfig;
