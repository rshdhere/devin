export const OPENAI_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "shell",
      description: "Run a shell command in the Devbox workspace.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          cwd: { type: "string" },
          timeout_sec: { type: "integer" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description:
        "Read a UTF-8 file from the Devbox. Path is relative to the repo root (e.g. app/page.tsx). Do not read node_modules.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "write_file",
      description:
        "Write a UTF-8 file in the Devbox. Path is relative to the repo root (e.g. app/page.tsx). Do not write under node_modules.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_dir",
      description:
        "List directory entries in the Devbox. Path is relative to the repo root (default: .). Avoid listing node_modules.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "git_commit",
      description:
        "Commit tracked changes using Conventional Commits. Message format: type(context): imperative summary, optional blank line, then up to 4 '- ' bullets. Example: feat(ui): add flappy bird canvas\\n\\n- Render bird on canvas\\n- Add collision checks. Do not include Co-authored-by — baby-devin-bot is added automatically.",
      parameters: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description:
              "Conventional commit: type(context): lowercase imperative summary, optionally followed by up to 4 bullet lines",
          },
          paths: { type: "array", items: { type: "string" } },
        },
        required: ["message"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "git_push",
      description: "Push the current branch to origin.",
      parameters: {
        type: "object",
        properties: { branch: { type: "string" } },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "browser_open",
      description: "Open a URL in the Devbox browser.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "desktop_screenshot",
      description: "Capture a desktop screenshot from the Devbox.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "save_memory",
      description: "Persist durable facts about this session for later turns.",
      parameters: {
        type: "object",
        properties: {
          facts: { type: "array", items: { type: "string" } },
        },
        required: ["facts"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "finish",
      description:
        "Mark the task complete and stop. Call when the request is done.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string" },
        },
        required: ["summary"],
      },
    },
  },
];
