ALTER TABLE "agent_sessions"
ADD COLUMN IF NOT EXISTS "session_recording_s3_key" text;
