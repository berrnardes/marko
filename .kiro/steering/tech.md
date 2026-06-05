# Tech Stack

## Language & runtime

- **TypeScript** (strict mode) on **Node.js >= 20**, ESM modules.
- One language across UI, API, and workers.

## Frameworks & libraries

- **Next.js 16** (App Router) + **React 19** — hosts the CRM UI, internal API, and the WAHA inbound webhook route.
- **Drizzle ORM** + **drizzle-kit** over **PostgreSQL** (`pg`) — type-safe, SQL-first schema and migrations.
- **pg-boss** — PostgreSQL-backed job queue for delayed cadence/nurture jobs, cron schedules, and per-job cancellation (no Redis).
- **LangChain.js + LangGraph** (`@langchain/langgraph`) with **zod** — the conversational qualification agent, modeled as a compiled state graph with structured-output extraction. The chat model is injectable so the LLM provider is swappable and mockable in tests.
- **Better Auth** — authentication; owns its own tables and migrations.
- **TanStack React Query** — client data fetching/caching in the CRM UI.
- **Tailwind CSS v4** (via `@tailwindcss/postcss`).
- **WAHA** — self-hosted, external service for the unofficial WhatsApp protocol (sendText, presence, sendSeen, message webhook with HMAC SHA-512).

## Testing

- **Vitest** is the test runner; **fast-check** for property-based testing (PBT).
- Pure core logic carries the correctness properties and is property-tested.
- Every property test runs **>= 100 iterations** — the default is set globally in `vitest.setup.ts`; individual tests may raise it but must not lower it.
- Test files are co-located in `src/**/*.{test,spec}.ts` and under `tests/`.

## Common commands

```bash
npm run dev          # Next.js dev server
npm run build        # production build
npm run start        # serve production build
npm run worker       # run the pg-boss worker process (tsx src/worker/index.ts)
npm run worker:dev   # worker in watch mode
npm run test         # run all tests once (vitest run)
npm run test:watch   # tests in watch mode
npm run typecheck    # tsc --noEmit
npm run lint         # eslint (eslint-config-next)
npm run db:generate  # generate Drizzle migrations from schema
npm run db:migrate   # apply migrations
```

> Avoid running long-lived commands (`dev`, `worker:dev`, `test:watch`) in automation — they block. Use `npm run test` and `npm run typecheck` to verify changes.

## Configuration

- Path alias **`@/*` → `./src/*`** (defined in `tsconfig.json`, mirrored in `vitest.config.ts`).
- `DATABASE_URL` drives both the app and `drizzle.config.ts` (defaults to `postgres://localhost:5432/marko`).
- Two processes share one database and the same domain modules: the Next.js deployment and the long-running worker. Only their entry points differ.
