# Marko

A multi-tenant WhatsApp lead-reactivation CRM for the Brazilian consórcio market. It imports cold leads, runs them through a structured 5-touch outreach cadence over 14 days, and hands them off to a human consultant the moment they reply.

## How it works

1. **Import** — leads come in via CSV upload or inbound WhatsApp messages.
2. **Cadence** — 5 outbound touches (T1 on day 0, T2 day 3, T3 day 7, T4 day 11, T5 day 14) are scheduled as durable jobs in pg-boss.
3. **Reply** — when a lead replies, all pending automation is cancelled and the lead is handed off to a consultant via a WhatsApp alert.
4. **Anti-ban** — every outbound message goes through a single choke point that enforces a daily send cap per number (with a warm-up ramp), a configurable business-hours send window, and randomized inter-message delays.

## Stack

| Layer | Technology |
|---|---|
| Web app | Next.js 16 (App Router), React 19, TypeScript |
| Database | PostgreSQL 17 + Drizzle ORM |
| Auth | Better Auth (email/password, organization plugin) |
| Job queue | pg-boss (Postgres-backed durable queues) |
| WhatsApp | WAHA (self-hosted gateway, GOWS engine) |
| UI | Tailwind CSS v4, shadcn/ui, React Query v5 |
| Hosting | Vercel (web app) + Hetzner VPS (DB, worker, WAHA) |

## Architecture

The system is split into two processes that share the same domain code:

- **Web app** (Next.js on Vercel) — handles the CRM UI, API routes, and lead enrollment. Enqueues jobs but never consumes them.
- **Worker** (long-running Node.js on Hetzner) — consumes pg-boss queues for cadence scheduling, outbound sends, and inbound webhook processing.

Multi-tenancy is enforced at two levels: the application scopes every query to `organization_id`, and PostgreSQL RLS policies provide a second enforcement layer for web requests.

## Getting started

### Prerequisites

- Node.js ≥ 20
- Docker and Docker Compose

### Local setup

```bash
# 1. Copy and configure environment variables
cp .env.development.example .env
# Edit .env — at minimum set DATABASE_URL, BETTER_AUTH_SECRET, WAHA_WEBHOOK_HMAC_SECRET

# 2. Start PostgreSQL and WAHA
docker compose -f docker-compose.dev.yml up -d

# 3. Run migrations and create the first admin user
npm run db:migrate
npm run db:seed-admin   # reads ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME from .env

# 4. Start the app and worker (two terminals)
npm run dev          # Next.js on http://localhost:3001
npm run worker:dev   # Worker with hot reload
```

To run the worker inside Docker instead:

```bash
docker compose -f docker-compose.dev.yml --profile worker up -d
```

To wipe everything and start fresh:

```bash
docker compose -f docker-compose.dev.yml down -v
```

### Key environment variables

| Variable | Description |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `BETTER_AUTH_SECRET` | Session signing secret (`openssl rand -base64 32`) |
| `BETTER_AUTH_URL` | App origin — `http://localhost:3001` in dev |
| `WAHA_API_KEY` | Must match on both app and WAHA container sides |
| `WAHA_WEBHOOK_HMAC_SECRET` | HMAC secret for inbound webhook signature verification |
| `WAHA_BASE_URL` | Where the app/worker reach WAHA — `http://localhost:3000` in dev |
| `WAHA_WEBHOOK_URL` | Where WAHA delivers events — use `http://host.docker.internal:3001/api/waha/webhook` in dev |
| `TZ` | Must be `America/Sao_Paulo` — drives business-hour windows and daily cap resets |
| `CRM_BASE_URL` | Base URL used in consultant alert deep-links |
| `CADENCE_TEST_MODE` | Set to `1` to collapse cadence offsets from days to seconds for testing |

Anti-ban tuning (all optional, sensible defaults apply):

| Variable | Default |
|---|---|
| `ANTIBAN_BASE_DAILY_CAP` | `40` |
| `ANTIBAN_WARMUP_INITIAL_CAP` | `10` |
| `ANTIBAN_WARMUP_RAMP_DAYS` | `7` |
| `ANTIBAN_DELAY_MIN_MS` | `30000` (30s) |
| `ANTIBAN_DELAY_MAX_MS` | `120000` (120s) |
| `ANTIBAN_SEND_WINDOW_START_HOUR` | `8` |
| `ANTIBAN_SEND_WINDOW_END_HOUR` | `19` |

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Next.js app on port 3001 |
| `npm run worker:dev` | Worker with hot reload (`tsx watch`) |
| `npm run build` | Production Next.js build |
| `npm test` | Run tests (Vitest) |
| `npm run typecheck` | TypeScript type check |
| `npm run db:generate` | Generate Drizzle migration files |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:seed-admin` | Create the initial admin user |
| `npm run db:clear` | Wipe all data (requires `CLEAR_DB_CONFIRM=yes`) |

## Production deployment

The production stack runs on a Hetzner VPS via `docker-compose.yml`:

```bash
# Generate TLS certs for PgBouncer (first time only)
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout certs/db.key -out certs/db.crt -subj "/CN=your-domain"

# Deploy
docker compose --env-file .env.production up -d --build
```

This brings up: Postgres, PgBouncer (public TLS entry point for Vercel), WAHA, the worker, Caddy (reverse proxy + Let's Encrypt), and a nightly `pg_dump` backup job. The Next.js app is deployed to Vercel separately via the CI workflow in `.github/workflows/`.

See `docs/deploy-hetzner.md` for the full runbook.

## Project structure

```
src/
├── app/              # Next.js App Router (pages, API routes)
│   ├── api/crm/      # CRM REST API (leads, numbers, templates, settings…)
│   └── crm/          # CRM UI pages
├── core/             # Pure domain logic (no I/O)
│   ├── lifecycle.ts  # 7-state lead FSM
│   ├── cadence.ts    # Touch scheduling offsets
│   ├── anti-ban.ts   # Daily cap, send-window, pacing math
│   └── types.ts      # Domain types and interfaces
├── db/               # Drizzle schema, repositories, RLS wiring
├── services/         # I/O-bound orchestration layer
│   ├── runtime.ts    # Process-wide singleton (pg-boss, queue wiring)
│   └── org-runtime.ts# Per-tenant composition root (OrgServices)
└── worker/           # Long-running worker entry point
```
