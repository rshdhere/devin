export {
  maybeTriggerDesktopSnapshotFromRuntime,
  maybeRememberPreviewPortFromText,
  triggerDesktopSnapshot,
} from "./desktop-capture-triggers.js";

export {
  fetchDesktopScreenshot,
  loadCachedDesktopSnapshot,
  persistDesktopSnapshot,
  schedulePostCompletionDesktopCapture,
  captureDevboxPreviewAfterAgent,
  smokeAndCaptureDevboxPreview,
} from "./desktop-capture-fetch.js";

export {
  captureDesktopScreenshotWithDevServer,
  runDesktopScreenshotWithDevServer,
  captureDesktopScreenshot,
  fetchRuntimeLiveScreenshot,
  fetchRuntimePersistedScreenshot,
  refreshDevboxPreviewPort,
  resolveLiveSession,
  startDevboxPreviewWatcher,
  proxyDevboxPreview,
} from "./desktop-capture-render.js";
