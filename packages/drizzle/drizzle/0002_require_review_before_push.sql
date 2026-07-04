ALTER TABLE "user_dashboard_settings"
ADD COLUMN IF NOT EXISTS "require_review_before_push" boolean DEFAULT false NOT NULL;
