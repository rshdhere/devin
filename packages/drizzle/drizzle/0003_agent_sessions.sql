CREATE TABLE IF NOT EXISTS "agent_tasks" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text,
  "prompt" text NOT NULL,
  "agent" text NOT NULL,
  "status" text NOT NULL,
  "title" text,
  "message" text,
  "repository" text,
  "branch" text,
  "pr_url" text,
  "preview_url" text,
  "deploy_status" text,
  "session_active" boolean DEFAULT false NOT NULL,
  "session_sleeping" boolean DEFAULT false NOT NULL,
  "sandbox_name" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "agent_tasks_user_id_idx" ON "agent_tasks" ("user_id");
CREATE INDEX IF NOT EXISTS "agent_tasks_status_idx" ON "agent_tasks" ("status");
CREATE INDEX IF NOT EXISTS "agent_tasks_updated_at_idx" ON "agent_tasks" ("updated_at" DESC);

CREATE TABLE IF NOT EXISTS "agent_task_events" (
  "id" text PRIMARY KEY NOT NULL,
  "task_id" text NOT NULL REFERENCES "agent_tasks"("id") ON DELETE CASCADE,
  "type" text NOT NULL,
  "message" text NOT NULL,
  "data" jsonb,
  "sequence" integer NOT NULL,
  "timestamp" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "agent_task_events_task_id_idx" ON "agent_task_events" ("task_id");
CREATE INDEX IF NOT EXISTS "agent_task_events_task_sequence_idx" ON "agent_task_events" ("task_id", "sequence");

CREATE TABLE IF NOT EXISTS "agent_sessions" (
  "task_id" text PRIMARY KEY NOT NULL REFERENCES "agent_tasks"("id") ON DELETE CASCADE,
  "sandbox_name" text NOT NULL,
  "runtime_base_url" text NOT NULL,
  "repo_cwd" text NOT NULL,
  "state" text NOT NULL DEFAULT 'active',
  "job_json" text NOT NULL,
  "github_token" text,
  "created_new_repo" boolean DEFAULT false NOT NULL,
  "guest_host" text,
  "last_active_at" timestamp DEFAULT now() NOT NULL,
  "sleeping_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "agent_sessions_state_idx" ON "agent_sessions" ("state");
CREATE INDEX IF NOT EXISTS "agent_sessions_last_active_idx" ON "agent_sessions" ("last_active_at");
