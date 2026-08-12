import type { ScaffoldFile } from "./scaffold-from-draft.js";

function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 32) || "devin-app"
  );
}

export function nextjsShellFiles(
  title: string,
  prompt: string,
): ScaffoldFile[] {
  const name = slugify(title);

  return [
    {
      path: "package.json",
      content: JSON.stringify(
        {
          name,
          version: "0.1.0",
          private: true,
          scripts: {
            dev: "next dev --hostname 127.0.0.1 --port 3000",
            build: "next build",
            start: "next start --hostname 127.0.0.1 --port 3000",
            lint: "next lint",
          },
          dependencies: {
            next: "^15.2.0",
            react: "^19.0.0",
            "react-dom": "^19.0.0",
          },
          devDependencies: {
            "@types/node": "^22.15.3",
            "@types/react": "^19.0.0",
            "@types/react-dom": "^19.0.0",
            typescript: "^5.9.2",
          },
        },
        null,
        2,
      ),
    },
    {
      path: "tsconfig.json",
      content: JSON.stringify(
        {
          compilerOptions: {
            target: "ES2017",
            lib: ["dom", "dom.iterable", "esnext"],
            allowJs: true,
            skipLibCheck: true,
            strict: true,
            noEmit: true,
            esModuleInterop: true,
            module: "esnext",
            moduleResolution: "bundler",
            resolveJsonModule: true,
            isolatedModules: true,
            jsx: "preserve",
            incremental: true,
            plugins: [{ name: "next" }],
            paths: { "@/*": ["./*"] },
          },
          include: [
            "next-env.d.ts",
            "**/*.ts",
            "**/*.tsx",
            ".next/types/**/*.ts",
          ],
          exclude: ["node_modules"],
        },
        null,
        2,
      ),
    },
    {
      path: "next.config.ts",
      content: `import type { NextConfig } from "next";

const nextConfig: NextConfig = {};

export default nextConfig;
`,
    },
    {
      path: "next-env.d.ts",
      content: `/// <reference types="next" />
/// <reference types="next/image-types/global" />
`,
    },
    {
      path: "app/globals.css",
      content: `:root {
  color-scheme: light dark;
  font-family: system-ui, -apple-system, sans-serif;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  background: linear-gradient(180deg, #0f172a 0%, #1e293b 100%);
  color: #f8fafc;
}

main {
  max-width: 48rem;
  margin: 0 auto;
  padding: 3rem 1.5rem;
}

h1 {
  margin: 0 0 0.75rem;
  font-size: 2rem;
}

p {
  margin: 0;
  line-height: 1.6;
  color: #cbd5e1;
}
`,
    },
    {
      path: "app/layout.tsx",
      content: `import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "${title.replace(/"/g, '\\"')}",
  description: ${JSON.stringify(prompt.slice(0, 160))},
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`,
    },
    {
      path: "app/page.tsx",
      content: `export default function HomePage() {
  return (
    <main>
      <h1>${title.replace(/"/g, '\\"')}</h1>
      <p>
        Next.js App Router scaffold — the agent will implement your request here.
      </p>
    </main>
  );
}
`,
    },
    {
      path: "app/health/route.ts",
      content: `import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json({ ok: true });
}
`,
    },
  ];
}
