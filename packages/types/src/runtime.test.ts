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
  test("brain uses the prompt stack snapshot", () => {
    expect(resolveRuntimeForTask("brain", "python django app")).toBe("python");
  });

  test("brain uses rust stack from prompt", () => {
    expect(resolveRuntimeForTask("brain", "build a rust cli with cargo")).toBe(
      "rust",
    );
  });

  test("explicit runtime overrides prompt inference", () => {
    expect(
      resolveRuntimeForTask("brain", "make a chess app using nextjs", "node"),
    ).toBe("node");
  });

  test("mock uses prompt stack", () => {
    expect(resolveRuntimeForTask("mock", "python django app")).toBe("python");
  });
});
