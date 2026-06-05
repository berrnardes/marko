// Lifecycle manager (I/O boundary — persisted lifecycle state transitions).
//
// Implements the design's `Lifecycle_Manager (pure transition + persistence
// wrapper)` as the persistence wrapper around the pure `transition` function in
// `@/core/lifecycle`. The pure layer is the single source of truth for which
// lifecycle moves are lawful and owns the correctness properties (Property 19);
// this module adds the persistence that applies a move only when the pure check
// accepts it, so a rejected transition never writes and the lead is left in its
// existing state (Req 14.5).
//
// Side-effect boundary: this module reads and writes lead lifecycle state
// through the injected `LeadRepository` interface (never concrete Drizzle/DB
// code). It performs no other I/O and needs no `Clock` seam — the persisted
// `updated_at` is stamped by the repository/DB on each write, and the
// optimistic-concurrency precondition is expressed against the stored
// `lifecycle_state` (paired with `updated_at`) by the repository's
// compare-and-set, not by a timestamp this service computes.
//
// Responsibilities (this task — Req 14.1, 19.4):
//   - wrap the pure `transition(from, to)` with persistence that writes only on
//     success, so the persisted state always reflects exactly one valid
//     lifecycle state (Req 14.1) and only changes when a transition is accepted
//     (Req 19.4);
//   - apply the write through the repository's compare-and-set on
//     `lifecycle_state`/`updated_at` (optimistic concurrency) so a concurrent
//     writer that has already moved the lead cannot be silently overwritten,
//     preserving the single-state invariant under concurrency (Req 14.1, 19.4).

import { transition, type TransitionResult } from "@/core/lifecycle";
import type { LifecycleState } from "@/core/types";
import type { LeadRepository } from "@/services/repositories";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Raised when an operation references a `leadId` that has no persisted
 * `LeadSnapshot`. A missing lead has no current lifecycle state to transition
 * from, so callers must treat this as a hard error rather than silently
 * creating or assuming a state.
 */
export class UnknownLeadError extends Error {
	/** The unknown domain `leadId` that was looked up. */
	readonly leadId: string;

	constructor(leadId: string) {
		super(`No lead found for leadId "${leadId}"`);
		this.name = "UnknownLeadError";
		this.leadId = leadId;
	}
}

// ---------------------------------------------------------------------------
// Manager interface
// ---------------------------------------------------------------------------

/**
 * The I/O-bound lifecycle manager. Wraps the pure `@/core/lifecycle`
 * {@link transition} with persistence read/written through a
 * {@link LeadRepository}. It is the only component permitted to move a lead
 * between lifecycle states, so the single-state invariant (Req 14.1) is
 * enforced in one place.
 */
export interface LifecycleManager {
	/**
	 * Attempt to move a lead to `to`, persisting the new state **only when the
	 * pure transition is accepted** (Req 14.1, 19.4).
	 *
	 * The lead's current state is read first, then the pure
	 * {@link transition} validates the move:
	 *
	 *   - On a rejected transition (`ok: false`) nothing is written and the
	 *     rejection is returned unchanged — the persisted state is left intact
	 *     (Req 14.5, 19.4).
	 *   - On an accepted transition (`ok: true`) the new state is persisted via
	 *     the repository's compare-and-set keyed on the state that was read
	 *     (optimistic concurrency on `lifecycle_state`/`updated_at`), preserving
	 *     the single-state invariant under concurrent writers (Req 14.1).
	 *   - If the compare-and-set finds the state has changed since the read (a
	 *     concurrent writer won the race), the stale write is **not** applied;
	 *     the fresh state is re-read and returned as a rejection rather than a
	 *     success that did not happen (Req 14.1, 19.4).
	 *
	 * @param leadId - The lead to transition.
	 * @param to - The requested next lifecycle state.
	 * @returns The successful {@link TransitionResult} when the move was
	 *          persisted, or a rejection carrying the unchanged/fresh state.
	 * @throws {UnknownLeadError} when the `leadId` has no persisted lead.
	 */
	apply(leadId: string, to: LifecycleState): Promise<TransitionResult>;
}

// ---------------------------------------------------------------------------
// Construction configuration
// ---------------------------------------------------------------------------

/** Construction dependencies for {@link LifecycleManagerService}. */
export interface LifecycleManagerConfig {
	/** Persistence boundary for lead lifecycle state (the compare-and-set seam). */
	leads: LeadRepository;
}

// ---------------------------------------------------------------------------
// LifecycleManagerService
// ---------------------------------------------------------------------------

/**
 * Concrete {@link LifecycleManager} backed by a {@link LeadRepository}.
 * Stateless beyond its dependency; every call reads the lead's current
 * persisted state before deciding and writing.
 */
export class LifecycleManagerService implements LifecycleManager {
	private readonly leads: LeadRepository;

	constructor(deps: LifecycleManagerConfig) {
		this.leads = deps.leads;
	}

	/** @inheritdoc */
	async apply(leadId: string, to: LifecycleState): Promise<TransitionResult> {
		const snapshot = await this.leads.findById(leadId);
		if (!snapshot) {
			throw new UnknownLeadError(leadId);
		}

		const from = snapshot.lifecycleState;

		// Pure validation first: an invalid move must never write (Req 14.5, 19.4).
		const result = transition(from, to);
		if (!result.ok) {
			return result;
		}

		// Accepted move: persist via compare-and-set on the state we read, so a
		// concurrent writer that already moved the lead cannot be overwritten
		// (optimistic concurrency on `lifecycle_state`/`updated_at`, Req 14.1).
		const updated = await this.leads.updateLifecycleState(leadId, from, to);
		if (updated) {
			return result;
		}

		// Compare-and-set miss: the persisted state changed between our read and
		// our write. We do NOT blindly overwrite — that would clobber whatever the
		// winning writer set and could violate the single-state invariant. Re-read
		// the fresh state and report a rejection against it rather than a success
		// that did not happen (Req 14.1, 19.4).
		const fresh = await this.leads.findById(leadId);
		if (!fresh) {
			throw new UnknownLeadError(leadId);
		}
		return {
			ok: false,
			reason: "invalid_transition",
			state: fresh.lifecycleState,
		};
	}
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Construct a {@link LifecycleManager} from {@link LifecycleManagerConfig}. */
export function createLifecycleManager(
	config: LifecycleManagerConfig,
): LifecycleManager {
	return new LifecycleManagerService(config);
}
