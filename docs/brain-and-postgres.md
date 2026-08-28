# Brain + self-hosted Postgres

Operational guide for **devin-brain** in EKS with in-cluster Postgres and execution-host **worker** schedulers.

**GitOps manifests live in [rshdhere/ops](https://github.com/rshdhere/ops)** (`production/devin/base/{postgres,brain,platform}/`, overlays). This repo contains application code, Docker images, and migrations only.

## Architecture

```text
Browser → devin-server → devin-brain:9092 → Postgres (in-cluster)
                              ↓
                    EXECUTION_WORKER_URL → EC2 scheduler :9091 (worker)
```

| Component | Where | Image |
|-----------|-------|-------|
| Postgres | EKS StatefulSet | `postgres:16-alpine` |
| Brain | EKS Deployment | `rshdhere/devin-brain:<sha>` |
| Server | EKS Deployment | `rshdhere/devin-server:<sha>` |
| Worker | EC2 systemd | `rshdhere/devin-scheduler:<sha>` |

---

## Next steps (after ops GitOps is committed)

Do these in order. Skip steps you've already finished.

### 1. Vault — Postgres credentials

```bash
vault kv put secret/prod/postgres \
  POSTGRES_USER=devin \
  POSTGRES_PASSWORD="$(openssl rand -base64 24)" \
  POSTGRES_DB=devin

vault kv put secret/staging/postgres \
  POSTGRES_USER=devin \
  POSTGRES_PASSWORD="$(openssl rand -base64 24)" \
  POSTGRES_DB=devin_staging
```

### 2. Vault — Server secret cleanup

Remove `DATABASE_URL` from `secret/prod/server` and `secret/staging/server` if it pointed at Neon. Server reads `DATABASE_URL` from the `devin-postgres` K8s secret (GitOps patch).

Keep: `BETTER_AUTH_SECRET`, OAuth keys, GitHub tokens, etc.

### 3. Push ops + Argo sync

```bash
cd /path/to/staging-ops   # or ops repo
git push
# Argo CD syncs production/devin and staging/devin apps
```

Watch sync: postgres → platform ConfigMap → brain → server (migrations run on server start).

### 4. Confirm devin-brain image exists

Ops pins `devin-brain` to the same SHA as `devin-server`. That commit must have been built by Registry on **devin** `main`:

```bash
docker pull rshdhere/devin-brain:f6c4dc4be4ca01d5a683574a063d0fe7e6147cd4   # prod example
```

If pull fails, push devin `main` (with brain in Registry matrix) and bump ops image tag.

### 5. Postgres NLB → SSM (execution workers)

After postgres is running:

```bash
kubectl -n devin-app get svc devin-postgres-external -w
# note EXTERNAL-IP / hostname

aws ssm put-parameter --region ap-south-1 \
  --name /devin-production/platform/database_url \
  --type SecureString --overwrite \
  --value 'postgres://devin:PASSWORD@<nlb-hostname>:5432/devin?sslmode=disable'
```

Repeat for staging if workers share staging DB (separate SSM prefix / NLB in `devin-staging` if applicable).

Ensure execution-host SG can reach the NLB on **5432**.

### 6. Execution hosts — worker mode

Deploy latest **devin** scheduler image (includes `SERVICE_MODE=worker` support), then on each host:

```bash
sudo devin-infra sync-platform-config
curl -s http://127.0.0.1:9091/health | jq .
# expect: "mode": "worker", "durable": true (when DATABASE_URL set)
```

`devin-infra sync-platform-config` sets `SERVICE_MODE=worker` and `DATABASE_URL` from SSM.

Update ops `devin-platform` ConfigMap `EXECUTION_WORKER_URL` if the worker is not `http://10.0.4.73:9091` (use scheduler NLB when available).

### 7. Migrations

`devin-server` runs Drizzle migrations on startup. Required: `0003_agent_sessions.sql` (and prior).

Manual fallback:

```bash
kubectl -n devin-app port-forward svc/devin-postgres 5432:5432 &
export DATABASE_URL='postgres://devin:PASS@localhost:5432/devin?sslmode=disable'
cd devin && bun run migrate
```

### 8. Verification

```bash
# Postgres + brain
kubectl -n devin-app get pods -l app=devin-postgres
kubectl -n devin-app get pods -l app=devin-brain
kubectl -n devin-app exec deploy/devin-server -- wget -qO- http://devin-brain:9092/health

# Staging
kubectl -n devin-staging get pods -l 'app in (devin-postgres,devin-brain)'

# Worker
curl -s http://<execution-host>:9091/health | jq .

# End-to-end: create a task in the UI; brain accepts, worker provisions devbox
```

---

## Ops repo layout (reference)

| Path in ops | Purpose |
|-------------|---------|
| `production/devin/base/postgres/` | ExternalSecret, StatefulSet, NLB |
| `production/devin/base/brain/` | Deployment + Service `:9092` |
| `production/devin/base/platform/configmap.yaml` | `EXECUTION_WORKER_URL` |
| `production/devin/overlays/external/patch-external-secret.yaml` | `SCHEDULER_URL` → brain |
| `production/devin/overlays/external/patch-server-database.yaml` | Server `DATABASE_URL` from postgres secret |
| `staging/devin/overlays/external/` | Same stack in `devin-staging` namespace |

When staging shares the production EC2 execution host, the staging `FirecrackerHost` CR **`metadata.name` must match `SCHEDULER_HOST_NAME` on the worker** (e.g. `devin-production-fc-01`). A staging-only name such as `devin-staging-fc-01` causes sandbox host / scheduler pin mismatches.

---

## This repo (devin)

| Area | Path |
|------|------|
| Brain app | `apps/brain/` |
| Docker | `docker/brain/Dockerfile` |
| CI images | `.github/workflows/registry.yaml` |
| Migrations | `packages/drizzle/drizzle/0004_desktop_snapshot.sql` |
| Worker SSM sync | `devin-infra sync-platform-config` (see `infra/README-cli.md`) |
| Alignment | `docs/devin-alignment.md` |

### HydraDB session memory (optional)

Brain can ingest/recall long-lived session context into HydraDB. Create a database (e.g. `devin-context`) in the HydraDB console, then put credentials on the Brain secret:

```bash
# Vault (preferred once ExternalSecret is synced)
vault kv put secret/staging/brain \
  OPENAI_API_KEY="sk-..." \
  OPENAI_MODEL=gpt-4o-mini \
  HYDRADB_API_KEY="..." \
  HYDRADB_DATABASE=devin-context \
  HYDRADB_TENANT_ID=devin-context \
  HYDRADB_BASE_URL=https://api.hydradb.com

# Or patch the live K8s secret directly
kubectl -n devin-staging create secret generic devin-brain \
  --from-literal=OPENAI_API_KEY="sk-..." \
  --from-literal=OPENAI_MODEL=gpt-4o-mini \
  --from-literal=HYDRADB_API_KEY="..." \
  --from-literal=HYDRADB_DATABASE=devin-context \
  --from-literal=HYDRADB_TENANT_ID=devin-context \
  --from-literal=HYDRADB_BASE_URL=https://api.hydradb.com \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n devin-staging rollout restart deploy/devin-brain
```

Without `HYDRADB_API_KEY`, follow-ups still work via Postgres event history only — the HydraDB console will stay at 0 memories.

**Where ingest runs (Brain mode):** Brain owns `HYDRADB_*`. As soon as a harness starts, Brain seeds the user prompt into HydraDB, then upserts a fuller session snapshot after the harness finishes. Collection defaults to the Devin **user id** (or `task-<taskId>` if no user) unless `HYDRADB_COLLECTION` is set. Worker `agent-complete` may also call ingest, but that is a no-op unless the execution host has the same secrets — do not rely on the worker.

**Important (HydraDB v2):** each memory item's `metadata` field must be a **JSON-encoded string**. Passing a nested object returns `400 INVALID_INPUT` and no context is stored.

### HydraDB + Interactive verification (staging)

```bash
# 1. Brain must log HydraDB enabled at startup (not "disabled")
kubectl -n devin-staging logs deploy/devin-brain --tail=80 | grep '\[hydradb\]'
# expect: [hydradb] enabled database=devin-context …

# 2. Run a short staging task in the UI. In session Progress, look for:
#    - "HydraDB prompt memory seeded"
#    - "HydraDB session memory ingested after harness"
# In HydraDB → Context / Logs, open collection `<yourUserId>` (not only
# an old probe-* collection). You should see new POST /context/ingest rows.

# 3. Interactive: open a completed Next/Node session → Interactive.
# Guest Chromium should navigate to http://127.0.0.1:3099/ (managed preview),
# not sit on localhost:3000 with ERR_CONNECTION_REFUSED. Snapshot thumbnail
# and Interactive should both show the product UI.
```

### Host ENOSPC vs guest tmpfs

| Symptom | Where | What to do |
|---------|--------|------------|
| `clone golden rootfs` / `No space left` while copying to `/var/lib/devin/vms/...` | **Execution host** disk | Free `/var/lib/devin` (stale VM dirs). Firecracker prunes orphans on start + periodically, and blocks creates below `FIRECRACKER_MIN_FREE_DISK_GIB`. Ops: `sudo devin-infra free-disk` when available. |
| ENOSPC mid-run inside the guest (pip/npm/cargo caches) | Guest **workspace tmpfs** | Retry after runtime with 8G tmpfs + cache pruning; do not confuse with rootfs clone failures. |

HydraDB will not show new prompt ingest rows for tasks that die at sandbox create (host ENOSPC) — Brain only seeds memory after `sandbox-ready`. Fix host disk first, then confirm Progress shows `HydraDB prompt memory seeded` and open the **user id** collection in HydraDB Logs (not `probe-*`).

---

## Rollback

1. Ops overlay: set `SCHEDULER_URL` back to execution host (`http://10.0.4.73:9091`).
2. Scale `devin-brain` to 0 or remove from kustomization.
3. Execution hosts: remove `SERVICE_MODE=worker` from `/etc/devin/scheduler-secrets.env`, restart scheduler.
4. Restore Neon `DATABASE_URL` in Vault `prod/server` if needed.
