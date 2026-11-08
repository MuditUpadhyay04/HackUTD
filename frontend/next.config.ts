import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  devIndicators: false,
  partialPrefetching: true,
  experimental: {
    // proxy.ts (operator login) buffers request bodies, 10 MB by default. A week of telemetry.csv is ~20 MB, so
    // uploads through the console were cut off and rejected. Match the upload route's own 64 MB cap.
    proxyClientMaxBodySize: "64mb",
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
