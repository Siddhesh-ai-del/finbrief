import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typescript: {
    // Type errors fail the build; CI also runs `tsc --noEmit` separately.
    ignoreBuildErrors: false,
  },
  // Note: Next 16 removed the `eslint` build-integration option.
  // Lint runs as its own CI step (`npm run lint`).
};

export default nextConfig;
