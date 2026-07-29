# `@devin/api-v1`

Express HTTP API for Devin. Mounted by `apps/server` and served under `/api/v1`.

```ts
import { app } from "@devin/api-v1";
```

## Layout

```text
src/
  index.ts                 # Express app: CORS, Better Auth, JSON, router
  routes/index.ts          # Mounts feature routers under /api/v1/
  handlers/                # Route handlers (health, settings, github, tasks)
  lib/                     # Auth, CORS, GitHub, scheduler client, email helpers
  middleware/require-auth.ts
  types/express.d.ts       # Express.Request.auth augmentation
```

## Auth

Better Auth is mounted at `/api/v1/auth/*` via `toNodeHandler`. Session cookies are
set with credentials enabled; when web and auth share a parent domain, cross-subdomain
cookies and OAuth proxy are configured from env.

Protected routes use `requireAuth`, which loads the session and sets `req.auth`.

Supported sign-in paths (when configured):

- Email / password + verification email
- Magic link
- GitHub / Google social OAuth
- Windsurf generic OAuth (OIDC discovery)

## Routes

All paths below are relative to `/api/v1`.

| Method | Path | Auth | Description |
| ------ | ---- | ---- | ----------- |
| `GET` | `/` | no | Health check |
| `*` | `/auth/*` | — | Better Auth handler |
| `GET` | `/settings/dashboard` | yes | Dashboard settings |
| `PATCH` | `/settings/dashboard` | yes | Update dashboard settings |
| `GET` | `/github/status` | yes | GitHub connection + bot status |
| `GET` | `/github/repos` | yes | List user repositories |
| `PATCH` | `/github/permissions` | yes | Update GitHub permission flags |
| `POST` | `/github/repos/select` | yes | Select active repository |
| `GET` | `/tasks` | yes | List tasks (filtered to current user) |
| `POST` | `/tasks` | yes | Create task |
| `GET` | `/tasks/diagnostics/infra` | yes | Infra diagnostics |
| `GET` | `/tasks/:id` | yes | Get task |
| `GET` | `/tasks/:id/diagnostics` | yes | Task diagnostics |
| `POST` | `/tasks/:id/execute` | yes | Start execution |
| `POST` | `/tasks/:id/retry` | yes | Retry task |
| `POST` | `/tasks/:id/commit` | yes | Commit work |
| `POST` | `/tasks/:id/pr` | yes | Open pull request |
| `POST` | `/tasks/:id/continue` | yes | Continue session |
| `POST` | `/tasks/:id/terminate` | yes | Terminate session |
| `POST` | `/tasks/:id/wake` | yes | Wake suspended session |
| `POST` | `/tasks/:id/terminal` | yes | Run terminal command |
| `GET` | `/tasks/:id/files` | yes | List sandbox files |
| `GET` | `/tasks/:id/files/read` | yes | Read sandbox file |
| `GET` | `/tasks/:id/events` | yes | Stream task events (SSE) |
| `GET` | `/tasks/:id/events/history` | yes | Event history |

Task execution is proxied to the scheduler (`SCHEDULER_URL`).

## Environment

| Variable | Required | Purpose |
| -------- | -------- | ------- |
| `BETTER_AUTH_URL` | yes | Public auth / API origin |
| `BETTER_AUTH_SECRET` | yes | Auth secret |
| `WEB_APP_URL` | yes | Frontend origin (CORS, emails, cookies) |
| `SCHEDULER_URL` | no | Scheduler base URL (default `http://localhost:9091`) |
| `CORS_ALLOWED_ORIGINS` | no | Extra comma-separated allowed origins |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | no | GitHub OAuth |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | no | Google OAuth |
| `WINDSURF_CLIENT_ID` / `WINDSURF_CLIENT_SECRET` / `WINDSURF_DISCOVERY_URL` | no | Windsurf OAuth |
| `OAUTH_PRODUCTION_URL` | no | Production URL for Better Auth OAuth proxy |
| `GITHUB_BOT_TOKEN` / `GITHUB_BOT_NAME` | no | Bot identity for GitHub ops |
| `ALLOW_TEMPLATE_AGENT` | no | Allow template agent selection |

Database access comes from `@devin/drizzle` (connection env is defined there).

## Develop

From the repo root:

```bash
bun install
```

Typecheck this package:

```bash
cd packages/api/v1 && bunx tsc --noEmit
```

Run the HTTP server via `apps/server` (it imports and listens on this app):

```bash
bun run --filter @devin/server dev
```
