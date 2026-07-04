import { relations } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  boolean,
  index,
  integer,
  jsonb,
} from "drizzle-orm/pg-core";

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_userId_idx").on(table.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("account_userId_idx").on(table.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const userDashboardSettings = pgTable("user_dashboard_settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  repositoryLabel: text("repository_label")
    .default("No repository selected")
    .notNull(),
  selectedRepository: text("selected_repository"),
  environment: text("environment").default("Ubuntu").notNull(),
  githubCanCommit: boolean("github_can_commit").default(true).notNull(),
  githubCanCreatePr: boolean("github_can_create_pr").default(true).notNull(),
  githubCanCreateRepo: boolean("github_can_create_repo")
    .default(true)
    .notNull(),
  githubCanCreateIssue: boolean("github_can_create_issue")
    .default(true)
    .notNull(),
  githubCanPush: boolean("github_can_push").default(true).notNull(),
  requireReviewBeforePush: boolean("require_review_before_push")
    .default(false)
    .notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});

export const userRelations = relations(user, ({ many, one }) => ({
  sessions: many(session),
  accounts: many(account),
  dashboardSettings: one(userDashboardSettings),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}));

export const userDashboardSettingsRelations = relations(
  userDashboardSettings,
  ({ one }) => ({
    user: one(user, {
      fields: [userDashboardSettings.userId],
      references: [user.id],
    }),
  }),
);

export const agentTasks = pgTable(
  "agent_tasks",
  {
    id: text("id").primaryKey(),
    userId: text("user_id"),
    prompt: text("prompt").notNull(),
    agent: text("agent").notNull(),
    status: text("status").notNull(),
    title: text("title"),
    message: text("message"),
    repository: text("repository"),
    branch: text("branch"),
    prUrl: text("pr_url"),
    previewUrl: text("preview_url"),
    deployStatus: text("deploy_status"),
    sessionActive: boolean("session_active").default(false).notNull(),
    sessionSleeping: boolean("session_sleeping").default(false).notNull(),
    sandboxName: text("sandbox_name"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("agent_tasks_user_id_idx").on(table.userId),
    index("agent_tasks_status_idx").on(table.status),
    index("agent_tasks_updated_at_idx").on(table.updatedAt),
  ],
);

export const agentTaskEvents = pgTable(
  "agent_task_events",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => agentTasks.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    message: text("message").notNull(),
    data: jsonb("data"),
    sequence: integer("sequence").notNull(),
    timestamp: timestamp("timestamp").defaultNow().notNull(),
  },
  (table) => [
    index("agent_task_events_task_id_idx").on(table.taskId),
    index("agent_task_events_task_sequence_idx").on(
      table.taskId,
      table.sequence,
    ),
  ],
);

export const agentSessions = pgTable(
  "agent_sessions",
  {
    taskId: text("task_id")
      .primaryKey()
      .references(() => agentTasks.id, { onDelete: "cascade" }),
    sandboxName: text("sandbox_name").notNull(),
    runtimeBaseUrl: text("runtime_base_url").notNull(),
    repoCwd: text("repo_cwd").notNull(),
    state: text("state").notNull().default("active"),
    jobJson: text("job_json").notNull(),
    githubToken: text("github_token"),
    createdNewRepo: boolean("created_new_repo").default(false).notNull(),
    guestHost: text("guest_host"),
    lastActiveAt: timestamp("last_active_at").defaultNow().notNull(),
    sleepingAt: timestamp("sleeping_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("agent_sessions_state_idx").on(table.state),
    index("agent_sessions_last_active_idx").on(table.lastActiveAt),
  ],
);

export const agentTasksRelations = relations(agentTasks, ({ many, one }) => ({
  events: many(agentTaskEvents),
  session: one(agentSessions),
}));

export const agentTaskEventsRelations = relations(
  agentTaskEvents,
  ({ one }) => ({
    task: one(agentTasks, {
      fields: [agentTaskEvents.taskId],
      references: [agentTasks.id],
    }),
  }),
);

export const agentSessionsRelations = relations(agentSessions, ({ one }) => ({
  task: one(agentTasks, {
    fields: [agentSessions.taskId],
    references: [agentTasks.id],
  }),
}));

export const schema = {
  user,
  session,
  account,
  verification,
  userDashboardSettings,
  agentTasks,
  agentTaskEvents,
  agentSessions,
  userRelations,
  sessionRelations,
  accountRelations,
  userDashboardSettingsRelations,
  agentTasksRelations,
  agentTaskEventsRelations,
  agentSessionsRelations,
};
