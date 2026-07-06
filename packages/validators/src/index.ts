import { z } from "zod";

const name = z
  .string({ message: "invalid name" })
  .min(4, { message: "name should be minimum of 03 charachter(s)" })
  .max(26, { message: "name should be mximum of 24 charachter(s)" });

const email = z.email({ message: "invalid email" });

const password = z
  .string({ message: "invalid input" })
  .min(6, { message: "password should be of minimum 06 charachter(s)" })
  .max(24, { message: "password shouldn't be more than 24 charachter(s)" })
  .regex(
    /^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]).{6,}$/,
    {
      message:
        "password(s) require atleast 01 capital-letter, 01 special-charachter, 01 number",
    },
  );

export const authSchema = {
  signup: z.object({
    name,
    email,
    password,
  }),
  login: z.object({
    email,
    password,
  }),
};

export const dashboardSettingsSchema = {
  update: z.object({
    repositoryLabel: z
      .string()
      .min(1, { message: "repository label is required" })
      .max(64)
      .optional(),
    selectedRepository: z
      .string()
      .regex(/^[\w.-]+\/[\w.-]+$/, { message: "invalid repository format" })
      .nullable()
      .optional(),
    environment: z
      .string()
      .min(1, { message: "environment is required" })
      .max(32)
      .optional(),
    githubCanCommit: z.boolean().optional(),
    githubCanCreatePr: z.boolean().optional(),
    githubCanCreateRepo: z.boolean().optional(),
    githubCanCreateIssue: z.boolean().optional(),
    githubCanPush: z.boolean().optional(),
    requireReviewBeforePush: z.boolean().optional(),
  }),
};

export const githubPermissionsSchema = {
  update: z.object({
    canCommit: z.boolean(),
    canCreatePr: z.boolean(),
    canCreateRepo: z.boolean(),
    canCreateIssue: z.boolean(),
    canPush: z.boolean(),
  }),
};

export const createTaskSchema = z.object({
  prompt: z.string().min(1).max(8000),
  agent: z.enum(["cursor", "claude", "mock"]).optional(),
  runtime: z
    .enum(["agent", "nextjs", "node", "go", "rust", "python"])
    .optional(),
  repository: z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/)
    .optional(),
  createRepository: z
    .string()
    .regex(/^[\w.-]+$/)
    .optional(),
  autoCreateRepository: z.boolean().optional(),
  autoStartSandbox: z.boolean().optional(),
  testCommand: z.string().min(1).max(500).optional(),
  issueTitle: z.string().min(1).max(200).optional(),
  issueBody: z.string().max(8000).optional(),
});

export type DashboardSettingsUpdate = z.infer<
  typeof dashboardSettingsSchema.update
>;

export type GitHubPermissionsUpdate = z.infer<
  typeof githubPermissionsSchema.update
>;

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
