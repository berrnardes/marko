# Implementation Plan: WhatsApp Lead-Reactivation Agent ("Marko")

## Overview

This plan implements the WhatsApp lead-reactivation agent and CRM in TypeScript/Node.js (>= 20) on Next.js (App Router), with Drizzle ORM + PostgreSQL, pg-boss scheduling, Better Auth, and a LangChain.js/LangGraph + zod qualification agent. Tests use Vitest with fast-check for property-based testing.

The build order follows the design's layering: the deterministic **pure core** (phone normalization, scoring, classification, lifecycle transition table, send guard, opt-out detection, anti-ban accounting, cadence/nurture timing, message templating) is implemented and property-tested first, then the **data layer**, then the **I/O-bound domain services** (WAHA client, anti-ban controller, lifecycle/compliance/handoff managers, importer, cadence/nurture/outbound workers, the LangGraph qualification agent, inbound handler), and finally the **entry points** (webhook route, auth, CRM UI) and full wiring.

Each of the 24 correctness properties from the design is realized by exactly one fast-check property-based test, running a minimum of 100 iterations and tagged `Feature: whatsapp-lead-reactivation-agent, Property {n}: ...`.

## Tasks

- [x] 1. Set up project, tooling, and core domain types
  - [x] 1.1 Scaffold the TypeScript/Next.js project and toolchain
    - Initialize a Next.js (App Router) + TypeScript (Node >= 20) project with one deployable web/API app and a separate long-running worker entry point that shares domain modules
    - Add and configure dependencies: Drizzle ORM + PostgreSQL driver, pg-boss, Better Auth, `@langchain/langgraph` + `@langchain/core` + zod, Vitest, and fast-check
    - Configure Vitest (TS/ESM) and a fast-check setup that defaults each property run to a minimum of 100 iterations
    - Create the `src/core` (pure), `src/services` (I/O), `src/db` (Drizzle), `src/app` (Next.js routes/UI), and `src/worker` (pg-boss handlers) directory skeleton
    - _Requirements: 19.1_

  - [x] 1.2 Define core domain types, enums, and injectable seams
    - Define `LifecycleState`, `OptInStatus`, `Touch`, `LifecycleSnapshot`/`LeadSnapshot`, `QualificationFields`, `ScoringSignals`, `BehavioralSignals`, `AntiBanConfig`, and `NumberState` as plain-value TypeScript types
    - Define the injectable `clock` and `rng` seams used by pure timing/pacing functions and the repository interfaces (`LeadRepository`, `MessageRepository`, `ScheduledJobRepository`, `NumberRepository`, `ComplianceRepository`) referenced by services
    - _Requirements: 14.1, 19.1, 19.2_

- [x] 2. Implement phone normalization (pure core)
  - [x] 2.1 Implement `normalizePhone`
    - Write the pure, Brazilian-aware `normalizePhone(raw, "BR")` that strips formatting, applies the `+55` country code when absent, validates digit count, returns E.164 or `null`, and is idempotent
    - _Requirements: 1.2_

  - [ ]\* 2.2 Write property test for phone normalization
    - **Property 1: Phone normalization yields valid E.164 and is idempotent**
    - Generators must include Brazilian formats, non-numeric junk, and already-normalized E.164 values
    - **Validates: Requirements 1.2**

- [ ] 3. Implement scoring and classification (pure core)
  - [x] 3.1 Implement `computeBaseScore` and `applyBehavioral`
    - Write `computeBaseScore(signals)` summing only satisfied weights into 0–100, forcing 0 when `disqualifying` holds and 0 when no signal holds
    - Write `applyBehavioral(base, behavioral)` returning `min(100, base + bonuses)`
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 11.2, 11.3, 11.4, 11.5_

  - [ ]\* 3.2 Write property test for the base score
    - **Property 15: Base score equals the sum of satisfied weights, with disqualification forcing zero**
    - Generators must include all-false signals and the disqualifying override
    - **Validates: Requirements 10.1, 10.2, 10.3, 10.4**

  - [ ]\* 3.3 Write property test for behavioral additions
    - **Property 16: Behavioral additions are additive and capped at 100**
    - **Validates: Requirements 11.2, 11.3, 11.4, 11.5**

  - [x] 3.4 Implement score-band classification
    - Write the pure `classify(score)` returning `HOT` (>= 70), `WARM` (40–69), `cold` (1–39), or `DISQUALIFIED` (0) in its own module
    - _Requirements: 12.1, 12.2, 12.3, 12.4_

  - [ ]\* 3.5 Write property test for classification
    - **Property 17: Classification partitions the score range exactly**
    - Generators must include score boundaries 0/1/39/40/69/70/100
    - **Validates: Requirements 12.1, 12.2, 12.3, 12.4**

- [x] 4. Implement the lifecycle transition table (pure core)
  - [x] 4.1 Implement the `transition` function and transition table
    - Encode the transition table as the single source of truth; `transition(from, to)` returns success only for defined pairs, permits `OPTED_OUT` from every non-terminal state, rejects any transition out of `OPTED_OUT`, and leaves state unchanged on rejection
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5_

  - [ ]\* 4.2 Write property test for lifecycle transitions
    - **Property 19: Lifecycle transitions are valid exactly when defined, and OPTED_OUT is terminal**
    - **Validates: Requirements 14.1, 14.2, 14.3, 14.4, 14.5**

- [x] 5. Implement the send guard and opt-out detection (pure core)
  - [x] 5.1 Implement `evaluateSendGuard`
    - Write the pure predicate returning `skip_and_cancel` for states `REPLIED`/`QUALIFYING`/`HOT`/`WARM`/`DISQUALIFIED`/`OPTED_OUT`, when the block flag is set, or when `Opt_In_Status` is `opt_out`; otherwise `send`
    - _Requirements: 4.6, 5.2, 5.3, 5.4_

  - [ ]\* 5.2 Write property test for the send guard
    - **Property 7: Send guard stops outreach exactly on the defined stop conditions**
    - **Validates: Requirements 4.6, 5.2, 5.3, 5.4**

  - [x] 5.3 Implement `detectOptOut`
    - Write the pure PT-BR opt-out phrase detector returning a boolean
    - _Requirements: 15.1_

- [x] 6. Implement anti-ban accounting (pure core)
  - [x] 6.1 Implement cap, ramp, pacing, and send-window math
    - Write `currentDailyCap(cfg, dayInRamp)` (monotonic warm-up ramp), `canSend(cfg, n, dayInRamp, now)` returning `allow`/`defer_cap`/`defer_window`/`blocked`, `nextDelayMs(cfg, rng)` within `[delayMin, delayMax]`, and `withinSendWindow(cfg, now)`
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5, 17.1, 17.4, 18.2_

  - [ ]\* 6.2 Write property test for the daily cap and warm-up ramp
    - **Property 21: Per-number daily cap is never exceeded and the warm-up ramp is monotonic**
    - Generators must include day-0 and post-ramp days for the warm-up cap
    - **Validates: Requirements 16.1, 16.2, 16.3, 16.4, 16.5**

  - [ ]\* 6.3 Write property test for send pacing and send window
    - **Property 22: Send pacing stays within the configured delay range and send window**
    - Generators must include timestamps inside and outside the send window
    - **Validates: Requirements 17.1, 17.4**

  - [ ]\* 6.4 Write unit test for the day-0 warm-up cap boundary
    - Assert the cap equals the configured initial range on day 0 of the ramp
    - _Requirements: 16.4_

- [x] 7. Implement cadence/nurture timing and message templates (pure core)
  - [x] 7.1 Implement `plannedFireTime` and `nextNurtureDate`
    - Write the pure `plannedFireTime(touch, enrolledAt)` mapping T1→day 0, T2→day 3, T3→day 7, T4→day 11, T5→day 14–15, and `nextNurtureDate(from)` computing exactly one calendar month later with month-length edges handled
    - _Requirements: 3.3, 6.3_

  - [ ]\* 7.2 Write property test for cadence fire times
    - **Property 5: Cadence fire times follow the fixed offsets and are strictly increasing**
    - **Validates: Requirements 3.3**

  - [x] 7.3 Implement the `Message_Generator`
    - Write pure `renderTouch(touch, lead)` for T1–T5 (T1 personalized from the lead's collected data) and `renderNurture(lead)`
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.7_

  - [ ]\* 7.4 Write property test for touch templates
    - **Property 6: Touch templates are distinct and T1 is per-lead personalized**
    - **Validates: Requirements 4.7**

- [ ] 8. Checkpoint - Ensure all pure-core tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 9. Implement the data layer (Drizzle + PostgreSQL)
  - [x] 9.1 Define the Drizzle schema and migrations
    - Define `leads` (unique `phone_e164`, nullable qualification fields, enum-constrained `lifecycle_state`/`opt_in_status`, score, block flag), `messages`, `scheduled_jobs`, `whatsapp_numbers`, `handoff_events`, `compliance_records`, `import_reports`, and `import_rows` tables with check constraints; reserve Better Auth and `pgboss` schema ownership
    - _Requirements: 1.4, 2.2, 14.1, 19.1, 19.2, 19.3_

  - [x] 9.2 Implement the repositories
    - Implement the repository interfaces over Drizzle for leads, messages, scheduled jobs, numbers, and compliance records, persisting score/lifecycle updates
    - _Requirements: 19.4_

  - [ ]\* 9.3 Write property test for CRM persistence round-trips
    - **Property 24: CRM persistence round-trips lead, qualification, and message data**
    - Drive arbitrary core fields, nullable qualification fields, and message history through a disposable PostgreSQL schema
    - **Validates: Requirements 19.1, 19.2, 19.3, 19.4**

- [x] 10. Implement the WAHA client
  - [x] 10.1 Implement `WahaClient`
    - Implement `resolveChatId` (BR pre-2012 number resolution + caching), `sendText`, `startTyping`/`stopTyping`, and `sendSeen` against the WAHA REST API
    - _Requirements: 17.2, 17.3, 18.2_

  - [ ]\* 10.2 Write unit tests for WAHA client ordering behaviors
    - Assert typing presence is simulated before sending, and inbound messages are marked seen
    - _Requirements: 17.2, 17.3_

- [x] 11. Implement the Anti_Ban_Controller service
  - [x] 11.1 Implement the controller persistence wrapper
    - Wrap the pure accounting functions with per-number state: daily counter with date reset, current-cap lookup, set/read block flag, and stop assigning new sends to a blocked number
    - _Requirements: 16.1, 16.2, 16.5, 18.1, 18.3_

  - [ ]\* 11.2 Write unit test for block-flag-on-detection
    - Assert detecting a block sets the number's block flag
    - _Requirements: 18.1_

- [x] 12. Implement the Lifecycle_Manager service
  - [x] 12.1 Implement `LifecycleManager.apply`
    - Wrap the pure `transition` with persistence that writes only on success, using optimistic concurrency (compare-and-set on `lifecycle_state`/`updated_at`) to preserve the single-state invariant
    - _Requirements: 14.1, 19.4_

- [ ] 13. Implement the Compliance_Manager
  - [ ] 13.1 Implement opt-out application and lawful-basis recording
    - Implement `applyOptOut` (set `opt_out`, transition to `OPTED_OUT`, cancel all scheduled outreach) and `recordLawfulBasis` (append-only compliance record with status and timestamp), guaranteeing no outbound is sent while opted out
    - _Requirements: 15.1, 15.2, 15.3, 15.4_

  - [ ]\* 13.2 Write property test for opt-out handling
    - **Property 20: Opt-out is detected, recorded, and immediately silences all outreach**
    - **Validates: Requirements 15.1, 15.2, 15.3, 15.4**

- [ ] 14. Implement the outbound choke point (Outbound_Worker)
  - [ ] 14.1 Implement the outbound send job and worker
    - Implement the single send path: drop on opt-out, stop on block flag, defer outside the send window, check/increment the per-number daily counter against the current cap, wait the randomized delay, simulate typing, call `WAHA_Client.sendText`, and increment the counter while recording the message in the same transaction
    - _Requirements: 15.3, 16.2, 17.1, 17.2, 17.4, 18.2, 18.3_

  - [ ]\* 14.2 Write property test for blocked-number silencing
    - **Property 23: A blocked number is fully silenced**
    - **Validates: Requirements 18.2, 18.3**

- [ ] 15. Implement the Lead_Importer
  - [ ] 15.1 Implement CSV import
    - Parse each row, normalize the phone (record rejected rows with row number + reason), deduplicate by normalized number (update existing, count as updated), create new leads as `COLD_QUEUED` recording the source, enroll new leads via the `Cadence_Scheduler`, and return the created/updated/rejected report
    - _Requirements: 1.1, 1.3, 1.4, 1.5, 1.6, 2.1, 2.2, 2.3_

  - [ ]\* 15.2 Write property test for import report accounting
    - **Property 2: Import report accounting is complete and consistent**
    - **Validates: Requirements 1.1, 1.3, 1.6**

  - [ ]\* 15.3 Write property test for dedup, COLD_QUEUED, and source
    - **Property 3: Created leads are deduplicated and start COLD_QUEUED with their source**
    - **Validates: Requirements 1.4, 1.5, 2.1, 2.2**

- [ ] 16. Implement the Cadence_Scheduler and Cadence_Worker
  - [ ] 16.1 Implement the `Cadence_Scheduler`
    - Implement `enroll` (transition `COLD_QUEUED` → `IN_CADENCE`, create five persisted, cancellable pg-boss touch jobs T1–T5 at their planned fire times) and `cancelAll`
    - _Requirements: 2.3, 3.1, 3.2, 3.4_

  - [ ]\* 16.2 Write property test for enrollment and cancellable touches
    - **Property 4: Enrollment sets IN_CADENCE and creates five cancellable touches**
    - **Validates: Requirements 3.1, 3.2, 3.4**

  - [ ] 16.3 Implement the `Cadence_Worker`
    - On each touch job, re-read fresh state + block flag, run `evaluateSendGuard` (skip and cancel remaining jobs when stopped), otherwise render the touch and enqueue an outbound send; on T5 for a non-replying lead set `CADENCE_EXHAUSTED` and trigger nurture
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 5.1, 6.1_

- [ ] 17. Implement the Nurture_Scheduler and Nurture_Worker
  - [ ] 17.1 Implement monthly nurture scheduling
    - On `CADENCE_EXHAUSTED`, transition to `MONTHLY_NURTURE` and schedule recurring monthly outreach one calendar month apart; implement `cancel` and the worker that enqueues a nurture outbound send
    - _Requirements: 6.1, 6.2, 6.3_

  - [ ]\* 17.2 Write property test for cadence exhaustion into nurture
    - **Property 8: Cadence exhaustion flows into monthly nurture at a one-month interval**
    - Generators must include month-length boundaries for nurture dates
    - **Validates: Requirements 6.1, 6.2, 6.3**

- [ ] 18. Implement the Handoff_Manager
  - [ ] 18.1 Implement handoff
    - Transition the lead to `HOT` immediately regardless of current stage, persist a handoff event with the triggering reason, make collected data and history available to the consultant, and stop further automated outbound for that lead
    - _Requirements: 13.1, 13.2, 13.3, 13.4_

  - [ ]\* 18.2 Write property test for the hot-score handoff
    - **Property 18: Crossing 70 forces immediate handoff and HOT, then silences automation**
    - **Validates: Requirements 13.1, 13.2, 13.4**

- [ ] 19. Checkpoint - Ensure all service-layer tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 20. Implement the Qualification_Agent (LangGraph)
  - [ ] 20.1 Implement zod schemas, turn state, and graph scaffolding
    - Define `ExtractedFieldsSchema`, `AgentOutputSchema`, and `TurnState`; scaffold `buildQualificationGraph(deps)` with an injectable `BaseChatModel` and the `QualificationAgent` interface boundary
    - _Requirements: 8.1, 9.2_

  - [ ] 20.2 Implement the `extract_fields` and `persist_fields` nodes
    - `extract_fields` performs a `model.withStructuredOutput(ExtractedFieldsSchema)` call; `persist_fields` writes provided values progressively and never clears an already-set field omitted by a later extraction
    - _Requirements: 9.2, 9.4, 9.5_

  - [ ]\* 20.3 Write property test for progressive field extraction
    - **Property 13: Field extraction persists progressively and monotonically**
    - **Validates: Requirements 9.2, 9.4, 9.5**

  - [ ] 20.4 Implement the `select_next_question` node
    - Choose a single currently-null qualification field, or select none when all fields are filled
    - _Requirements: 9.3_

  - [ ]\* 20.5 Write property test for next-question selection
    - **Property 14: The next qualification question targets only unfilled fields**
    - **Validates: Requirements 9.3**

  - [ ] 20.6 Implement the `score_and_classify` and `detect_triggers` nodes
    - Recompute the score via `Scoring_Engine` and classify the band; route via conditional edges to the `handoff` node on frustration, an out-of-data request, or `score >= 70`, short-circuiting the reply path
    - _Requirements: 8.3, 8.5, 11.1, 12.1, 12.2, 12.3, 12.4, 13.1_

  - [ ]\* 20.7 Write property test for trigger routing to handoff
    - **Property 11: Behavioral triggers route a Lead to handoff**
    - **Validates: Requirements 8.3, 8.5**

  - [ ] 20.8 Implement the `generate_reply` and `guard` nodes
    - `generate_reply` produces the "Marko" persona reply (at most one question) via `model.withStructuredOutput(AgentOutputSchema)`; the `guard` repairs or rejects any reply with more than one question or asserting consórcio rate/group/contemplation facts whose tokens are absent from the lead's available data
    - _Requirements: 8.1, 8.2, 8.4, 8.6_

  - [ ]\* 20.9 Write property test for the outbound honesty/format guard
    - **Property 12: Outbound replies never assert unsupported facts or exceed one question**
    - **Validates: Requirements 8.4, 8.6**

  - [ ] 20.10 Compile the graph and implement `nextTurn`
    - Wire the nodes and conditional edges into the compiled graph behind `QualificationAgent.nextTurn`, beginning a new `QUALIFYING` lead with a single re-engagement question
    - _Requirements: 8.1, 9.1_

  - [ ]\* 20.11 Write unit tests for persona honesty and the opener
    - Assert the agent confirms it is an AI when asked directly (8.2) and opens with a single re-engagement question (9.1)
    - _Requirements: 8.2, 9.1_

- [ ] 21. Implement the Inbound_Handler and webhook route
  - [ ] 21.1 Implement the inbound pipeline
    - Identify the lead by normalized number (create one if none), persist the inbound message + timestamp, `sendSeen`, run opt-out detection (apply opt-out and stop if matched), otherwise cancel pending cadence/nurture jobs, advance `IN_CADENCE`/`MONTHLY_NURTURE` → `REPLIED` → `QUALIFYING`, recompute the score, and run the qualification turn
    - _Requirements: 6.4, 7.1, 7.2, 7.3, 7.4, 7.5, 11.1, 15.1, 17.3_

  - [ ]\* 21.2 Write property test for reply cancellation and advancement
    - **Property 9: An inbound reply cancels pending outreach and advances to qualification**
    - **Validates: Requirements 6.4, 7.2, 7.3**

  - [ ]\* 21.3 Write property test for inbound attribution and persistence
    - **Property 10: Inbound messages are attributed by normalized number and never lost**
    - **Validates: Requirements 7.1, 7.4, 7.5**

  - [ ] 21.4 Implement the `/api/waha/webhook` route
    - Verify the `X-Webhook-Hmac` (SHA-512) signature, validate the body against a schema, enforce idempotency by `wa_message_id`, persist the raw inbound, and enqueue processing with a fast `2xx` acknowledgement
    - _Requirements: 7.1, 7.4_

  - [ ]\* 21.5 Write integration test for the webhook route
    - Test HMAC verification (reject invalid/missing signatures) and idempotent handling of duplicate deliveries
    - _Requirements: 7.1, 7.4_

- [ ] 22. Implement authentication and the CRM UI
  - [ ] 22.1 Implement Better Auth and route protection
    - Configure Better Auth with its Drizzle adapter and guard every CRM_UI page and data endpoint, redirecting unauthenticated or expired sessions to authentication
    - _Requirements: 21.1, 21.2, 21.3_

  - [ ]\* 22.2 Write integration test for route protection
    - Assert unauthenticated/expired access is denied and authenticated access is granted
    - _Requirements: 21.1, 21.2, 21.3_

  - [ ] 22.3 Implement the CRM_UI pages
    - Build the lead list (state + score), lead detail (qualification fields + message history), CSV import with import-report display, and the handed-off leads view exposing collected data and history
    - _Requirements: 13.3, 20.1, 20.2, 20.3, 20.4_

  - [ ]\* 22.4 Write component tests for the CRM_UI
    - Test rendering of the lead list, lead detail, import report, and handoff view
    - _Requirements: 20.1, 20.2, 20.3, 20.4_

- [ ] 23. Wire entry points and integrate the system
  - [ ] 23.1 Wire the worker and web entry points
    - Register the pg-boss handlers (cadence, nurture, outbound) on the worker process and wire the importer endpoint, webhook route, and enrollment path into the Next.js app so external sources enroll through the same process
    - _Requirements: 2.3, 3.1, 16.2, 18.3_

  - [ ]\* 23.2 Write integration test for pg-boss scheduling
    - Test enqueue, per-lead cancellation, and recurring monthly nurture behavior end-to-end against PostgreSQL
    - _Requirements: 3.4, 6.3, 7.2_

- [ ] 24. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core implementation tasks are never optional.
- Each property test uses fast-check with a minimum of 100 iterations and is tagged `Feature: whatsapp-lead-reactivation-agent, Property {n}: ...`; each of Properties 1–24 is realized by exactly one property test.
- The pure core (Tasks 2–7) is implemented and property-tested before the I/O-bound services (Tasks 9–23) that depend on it, keeping property tests fast and deterministic against in-memory fakes and injectable seams (`clock`, `rng`, repositories, `WahaClient`, and a fake LangChain.js chat model).
- Each task references the specific requirements and/or correctness properties it implements for traceability; checkpoints ensure incremental validation.

## Task Dependency Graph

```json
{
	"waves": [
		{ "id": 0, "tasks": ["1.1"] },
		{ "id": 1, "tasks": ["1.2"] },
		{
			"id": 2,
			"tasks": [
				"2.1",
				"3.1",
				"3.4",
				"4.1",
				"5.1",
				"5.3",
				"6.1",
				"7.1",
				"7.3",
				"9.1"
			]
		},
		{
			"id": 3,
			"tasks": [
				"2.2",
				"3.2",
				"3.3",
				"3.5",
				"4.2",
				"5.2",
				"6.2",
				"6.3",
				"6.4",
				"7.2",
				"7.4",
				"9.2",
				"10.1"
			]
		},
		{ "id": 4, "tasks": ["9.3", "10.2", "11.1", "12.1", "20.1"] },
		{
			"id": 5,
			"tasks": ["11.2", "13.1", "14.1", "16.1", "18.1", "20.2", "20.4", "20.8"]
		},
		{
			"id": 6,
			"tasks": [
				"13.2",
				"14.2",
				"15.1",
				"16.2",
				"17.1",
				"18.2",
				"20.3",
				"20.5",
				"20.6",
				"20.9"
			]
		},
		{ "id": 7, "tasks": ["15.2", "15.3", "16.3", "17.2", "20.7", "20.10"] },
		{ "id": 8, "tasks": ["20.11", "21.1"] },
		{ "id": 9, "tasks": ["21.2", "21.3", "21.4"] },
		{ "id": 10, "tasks": ["21.5", "22.1"] },
		{ "id": 11, "tasks": ["22.2", "22.3"] },
		{ "id": 12, "tasks": ["22.4", "23.1"] },
		{ "id": 13, "tasks": ["23.2"] }
	]
}
```
