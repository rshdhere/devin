import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const localDevLoginPath = path.join(
  __dirname,
  "components/auth/local-dev-login.local.tsx",
);

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  transpilePackages: ["@devin/types"],
  webpack: (config) => {
    // Prefer the gitignored local-dev button when present; staging/prod keep the stub.
    if (fs.existsSync(localDevLoginPath)) {
      config.resolve.alias = {
        ...config.resolve.alias,
        "@/components/auth/local-dev-login": localDevLoginPath,
      };
    }
    return config;
  },
};

export default nextConfig;
