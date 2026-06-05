# Project Structure

## Layout

```
src/
  app/          Next.js App Router — CRM UI pages, internal API, WAHA webhook route
  core/         Pure domain logic (NO I/O) — property-tested correctness lives here
  services/     I/O + orchestration; repository interfaces (the persistence boundary)
  db/           Drizzle schema, migrations, DB client, repository implementations
  worker/       Long-running pg-boss worker entry point
tests/          Cross-cutting / smoke tests
.kiro/          Specs and steering
```

## Layered architecture

The codebase is deliberately layered by side-effect boundary:

1. **`src/core` — pure core.** Deterministic, side-effect-free functions over plain values: phone normalization, scoring, classification, the lifecycle transition table, the send guard, opt-out detection, anti-ban math, cadence/nurture timing, message templating. This layer holds the testable correctness properties.
2. **`src/services` — services.** Wire the pure core to the outside world (WAHA client, lifecycle/compliance/handoff managers, importer, workers' domain logic, the LangGraph agent, inbound handler). Depend on repository **interfaces**, not concrete DB code.
3. **`src/db` — data layer.** Drizzle schema + migrations + repository implementations. Better Auth and pg-boss own their own schemas alongside these tables.
4. **`src/app` & `src/worker` — entry points.** Share the same domain modules; only the entry differs.

Dependency direction flows **inward**: app/worker → services → core. Core depends on nothing else.

## Conventions

- **Keep `src/core` pure.** No I/O, no `Date.now()`, no `Math.random()` directly. Inject time and randomness through the `Clock` and `Rng` seams from `@/core/types` so functions stay deterministic and property-testable.
- **Barrel exports.** Each layer re-exports its modules from an `index.ts` so consumers import from a single path (`@/core`, `@/services`, `@/db`).
- **Domain types are the single source of truth.** Lifecycle states, enums, and field shapes live in `@/core/types` as string-literal unions. The Drizzle schema mirrors them with `as const satisfies readonly T[]` tuples that drive CHECK constraints, so any drift fails to compile.
- **Repository pattern.** Services depend on interfaces in `src/services/repositories.ts`; Drizzle-backed implementations live in `src/db`.
- **Use the `@/*` path alias** for imports across `src`; avoid deep relative paths.

## Code style

- **Tabs** for indentation.
- Every module opens with a **header comment** explaining its role and side-effect boundary.
- Public functions and types carry **JSDoc**, with inline **requirement references** (e.g. `(Req 5.2)`) tying code back to the spec.
- Prefer explicit, total, pure functions in core; document idempotency and totality where relevant.

## Tests

- Co-locate property/unit tests next to the code as `*.test.ts` / `*.spec.ts`, or place cross-cutting tests under `tests/`.
- New core functions and bug fixes should come with tests; property tests run >= 100 iterations.
