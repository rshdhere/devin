import { describe, expect, it } from "bun:test";
import {
  contentTypeForVncAsset,
  rewriteDesktopVncHtml,
} from "@scheduler/task/service/desktop-vnc-html.js";

describe("rewriteDesktopVncHtml", () => {
  it("rewrites module imports to absolute desktop-vnc asset paths", () => {
    const broken = `<!DOCTYPE html><html><body><div id="screen"></div>
<script type="module">
const pageBase = location.href.endsWith('/') ? location.href : location.href + '/';
import(new URL('assets/core/rfb.js', pageBase).href).then(({ default: RFB }) => {});
</script></body></html>`;

    const rewritten = rewriteDesktopVncHtml(broken, "task-123");
    expect(rewritten).toContain(
      "/api/v1/tasks/task-123/desktop-vnc/assets/core/rfb.js",
    );
    expect(rewritten).toContain("/api/v1/tasks/task-123/desktop-vnc/ws");
    expect(rewritten).not.toContain("new URL('assets/core/rfb.js'");
  });
});

describe("contentTypeForVncAsset", () => {
  it("forces javascript MIME for rfb modules", () => {
    expect(contentTypeForVncAsset("core/rfb.js")).toContain("javascript");
    expect(contentTypeForVncAsset("app/styles.css")).toContain("css");
  });
});
