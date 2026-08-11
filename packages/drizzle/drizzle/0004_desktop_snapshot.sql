ALTER TABLE "agent_sessions"
ADD COLUMN IF NOT EXISTS "preview_port" integer;

ALTER TABLE "agent_sessions"
ADD COLUMN IF NOT EXISTS "desktop_snapshot" bytea;
