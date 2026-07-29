import { describe, expect, test } from "bun:test";
import { inferStackFromPrompt, resolveRuntimeForTask } from "./runtime";

describe("inferStackFromPrompt", () => {
  test("detects Next.js", () => {
    expect(inferStackFromPrompt("Build a Next.js auth app")).toBe("nextjs");
  });

  test("detects Go", () => {
    expect(inferStackFromPrompt("make a go api with gin")).toBe("go");
  });

  test("detects Rust", () => {
    expect(inferStackFromPrompt("rust cli with cargo")).toBe("rust");
  });

  test("detects Python", () => {
    expect(inferStackFromPrompt("fastapi todo backend")).toBe("python");
  });

  test("detects Node for express/todo prompts", () => {
    expect(inferStackFromPrompt("make me a todo-app using nodejs")).toBe(
      "node",
    );
  });

  test("detects Node for chat-app prompts", () => {
    expect(inferStackFromPrompt("make me a chat-app using nodejs")).toBe(
      "node",
    );
  });

  test("defaults to node", () => {
    expect(inferStackFromPrompt("build something cool")).toBe("node");
  });
});

describe("resolveRuntimeForTask", () => {
  test("cursor always uses agent snapshot", () => {
    expect(resolveRuntimeForTask("cursor", "python django app")).toBe("agent");
  });

  test("mock uses prompt stack", () => {
    expect(resolveRuntimeForTask("mock", "python django app")).toBe("python");
  });
});
