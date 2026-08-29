import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: [
      "apps/web/**/*.test.ts",
      "packages/scheduler/**/desktop-computer.test.ts",
      "packages/scheduler/**/desktop-navigate.test.ts",
      "packages/scheduler/**/preview.test.ts",
      "packages/scheduler/**/preview-html.test.ts",
      "packages/scheduler/**/snapshot-store.test.ts",
    ],
  },
  resolve: {
    alias: {
      "@devin/secrets": path.join(root, "../../packages/secrets/src/index.ts"),
      "@devin/types": path.join(root, "../../packages/types/src/index.ts"),
      "@scheduler": path.join(root, "../../packages/scheduler/src"),
      "@harness": path.join(root, "../../apps/brain/src/harness/src"),
      "@web": path.join(root, "../../apps/web"),
    },
  },
});
