import type { NextConfig } from "next";
import { loadAndCheckEnv } from "@blindroll/core/env";

// One env file for the whole repo: <repo root>/.env.local. Fails at startup with the NAMES of
// missing variables (never values).
loadAndCheckEnv();

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
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
