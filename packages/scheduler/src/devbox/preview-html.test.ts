import { describe, expect, it } from "vitest";
import {
  rewriteDevboxPreviewCss,
  rewriteDevboxPreviewHtml,
} from "./preview-html.js";

const TASK = "abc-123";

describe("rewriteDevboxPreviewHtml", () => {
  it("rewrites root-relative href and src attributes", () => {
    const html =
      '<html><head><link rel="stylesheet" href="/_next/static/css/app.css" />' +
      '<script src="/_next/static/chunks/main.js"></script></head></html>';
    const out = rewriteDevboxPreviewHtml(html, TASK);
    expect(out).toContain(
      `/api/v1/tasks/${encodeURIComponent(TASK)}/devbox-preview?path=${encodeURIComponent("/_next/static/css/app.css")}`,
    );
    expect(out).toContain(
      `/api/v1/tasks/${encodeURIComponent(TASK)}/devbox-preview?path=${encodeURIComponent("/_next/static/chunks/main.js")}`,
    );
    expect(out).not.toContain('href="/_next');
  });
});

describe("rewriteDevboxPreviewCss", () => {
  it("rewrites root-relative url() paths", () => {
    const css =
      '@font-face { src: url(/_next/static/media/font.woff2) format("woff2"); }';
    const out = rewriteDevboxPreviewCss(css, TASK);
    expect(out).toContain(
      `/api/v1/tasks/${encodeURIComponent(TASK)}/devbox-preview?path=${encodeURIComponent("/_next/static/media/font.woff2")}`,
    );
  });
});
