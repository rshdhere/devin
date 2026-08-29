-- OAuth and session GitHub tokens stored as bytea (encrypted envelope blobs or legacy UTF-8 plaintext during migration).
ALTER TABLE "account"
  ALTER COLUMN "access_token" TYPE bytea USING CASE
    WHEN "access_token" IS NULL THEN NULL
    ELSE convert_to("access_token", 'UTF8')
  END,
  ALTER COLUMN "refresh_token" TYPE bytea USING CASE
    WHEN "refresh_token" IS NULL THEN NULL
    ELSE convert_to("refresh_token", 'UTF8')
  END,
  ALTER COLUMN "id_token" TYPE bytea USING CASE
    WHEN "id_token" IS NULL THEN NULL
    ELSE convert_to("id_token", 'UTF8')
  END;

ALTER TABLE "agent_sessions"
  ALTER COLUMN "github_token" TYPE bytea USING CASE
    WHEN "github_token" IS NULL THEN NULL
    ELSE convert_to("github_token", 'UTF8')
  END;
