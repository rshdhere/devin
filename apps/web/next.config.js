import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const localDevLoginPath = path.join(
  __dirname,
  "components/auth/local-dev-login.local.tsx",
);
const hasLocalDevLogin = fs.existsSync(localDevLoginPath);

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  transpilePackages: ["@devin/types"],
  // Next 16 defaults to Turbopack; keep an explicit config so webpack-only
  // aliases do not crash `next dev`.
  turbopack: hasLocalDevLogin
    ? {
        resolveAlias: {
          "@/components/auth/local-dev-login":
            "./components/auth/local-dev-login.local.tsx",
        },
      }
    : {},
  webpack: (config) => {
    if (hasLocalDevLogin) {
      config.resolve.alias = {
        ...config.resolve.alias,
        "@/components/auth/local-dev-login": localDevLoginPath,
      };
    }
    return config;
  },
};

export default nextConfig;
