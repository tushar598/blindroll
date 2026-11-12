import type { NextConfig } from "next";
import { assertStartupEnv, loadAndCheckEnv } from "@blindroll/core/env";

// One env file for the whole repo: <repo root>/.env.local. Fails at startup with the NAMES of
// missing variables (never values), and refuses JUDGE_SANDBOX=1 on mainnet.
loadAndCheckEnv();
assertStartupEnv();

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
