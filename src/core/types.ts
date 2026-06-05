// Core domain types, enums, and injectable seams (pure values, no I/O).
//
// Everything in this module is a plain-value TypeScript type, a string-literal
// union ("enum"), or an injectable seam (`Clock`, `Rng`). There is no logic and
// no side effects here — the pure functions and services in later tasks consume
// these declarations. Shapes mirror the design's Components/Interfaces and Data
// Models sections.

// `ClassificationBand` is owned by the score-band classifier (Req 12); it is
// re-exported here so consumers of `LeadSnapshot` and the repository
// interfaces continue to see it on the core types module.
export type { ClassificationBand } from "./classify";
import type { ClassificationBand } from "./classify";

// ---------------------------------------------------------------------------
// Lifecycle and lawful-basis enums
// ---------------------------------------------------------------------------

/**
 * The single lifecycle state a Lead occupies at any time (Req 14.1, 19.1).
 * Transitions between these states are governed by the lifecycle transition
 * table (implemented in a later task); `OPTED_OUT` is terminal (Req 14.4).
 */
export type LifecycleState =
	| "COLD_QUEUED"
	| "IN_CADENCE"
	| "REPLIED"
	| "QUALIFYING"
	| "HOT"
	| "WARM"
	| "DISQUALIFIED"
	| "CADENCE_EXHAUSTED"
	| "MONTHLY_NURTURE"
	| "OPTED_OUT";

/** The LGPD lawful-basis flag carried by every Lead (Req 15, 19.1). */
export type OptInStatus = "opt_in" | "opt_out";

/** A single scheduled outreach touch within the 5-touch cadence (Req 3). */
export type Touch = "T1" | "T2" | "T3" | "T4" | "T5";

/** A Lead's qualification objective (Req 9, 19.2). */
export type Objective = "housing" | "investment";

// ---------------------------------------------------------------------------
// Qualification fields
// ---------------------------------------------------------------------------

/**
 * The qualification data collected from a Lead. Every field is nullable so it
 * can be filled progressively across multiple conversation turns (Req 9.4,
 * 19.2); an already-set field is never cleared by a later partial extraction.
 */
export interface QualificationFields {
	/** Consórcio product category the Lead is interested in. */
	segment: string | null;
	/** Desired credit value. */
	creditValue: number | null;
	/** Whether the Lead's objective is housing or investment. */
	objective: Objective | null;
	/** Whether the Lead holds cash toward a bid (lance reserve). */
	hasLanceReserve: boolean | null;
	/** The Lead's declared income. */
	income: number | null;
}

// ---------------------------------------------------------------------------
// Lead snapshot (freshly-read state used by the send guard and workers)
// ---------------------------------------------------------------------------

/**
 * A freshly-read snapshot of a Lead's state, as consumed by the send guard
 * (`evaluateSendGuard(lead: LeadSnapshot)`) and the cadence/nurture/outbound
 * workers. It carries enough to evaluate the guard (lifecycle state, block
 * flag, opt-in status) plus the other relevant lead fields.
 */
export interface LeadSnapshot {
	id: string;
	/** Normalized E.164 phone number (the dedup key). */
	phoneE164: string;
	/** Originating source recorded on the lead (Req 2.1). */
	source: string;
	lifecycleState: LifecycleState;
	optInStatus: OptInStatus;
	/** Timestamp of the current lawful-basis value, when known. */
	optInAt: Date | null;
	/** Qualification score in 0–100. */
	score: number;
	/** Anti-ban / block flag re-checked by the send guard (Req 5.3, 18). */
	blocked: boolean;
	/** Current score-band label, when classified (Req 12). */
	classificationBand: ClassificationBand | null;
	/** Progressively-filled qualification fields. */
	qualification: QualificationFields;
	/** Consultant the lead is assigned to after handoff, when any (Req 13). */
	assignedConsultantId: string | null;
	lastOutboundAt: Date | null;
	lastInboundAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
}

/**
 * Alias for {@link LeadSnapshot}. The design refers to the freshly-read lead
 * state both as a "lifecycle snapshot" and a "lead snapshot"; they are the same
 * value shape.
 */
export type LifecycleSnapshot = LeadSnapshot;

// ---------------------------------------------------------------------------
// Scoring signals
// ---------------------------------------------------------------------------

/**
 * Boolean scoring signals and their point weights (Req 10). The base score is
 * the sum of the weights whose condition holds, in the inclusive range 0–100;
 * when `disqualifying` holds the score is forced to 0 (Req 10.4), and when no
 * signal holds the score is 0 (Req 10.3).
 */
export interface ScoringSignals {
	/** All qualification questions answered (+20). */
	allQuestionsAnswered: boolean;
	/** Income compatible with the desired value (+25). */
	incomeCompatible: boolean;
	/** Holds a lance reserve (+20). */
	hasLanceReserve: boolean;
	/** Clear objective of housing or investment (+15). */
	clearObjective: boolean;
	/** Replied within 10 minutes (+10). */
	repliedWithin10Min: boolean;
	/** Replied during the Send_Window business hours (+5). */
	repliedInSendWindow: boolean;
	/** Mobile number that is not VoIP (+5). */
	mobileNonVoip: boolean;
	/** Income incompatible or no real interest — forces the score to 0. */
	disqualifying: boolean;
}

/**
 * Behavioral signals applied to the base score on inbound messages (Req 11).
 * The additions are additive and the total is capped at 100 (Req 11.5).
 */
export interface BehavioralSignals {
	/** Replied within 2 minutes of the prior outbound message (+10). */
	repliedWithin2Min: boolean;
	/** Inbound asked about available groups or lance (+10). */
	askedAboutGroupsOrLance: boolean;
	/** Inbound mentioned an urgent deadline (+15). */
	mentionedUrgentDeadline: boolean;
}

// ---------------------------------------------------------------------------
// Anti-ban configuration and per-number state
// ---------------------------------------------------------------------------

/**
 * Configuration for the anti-ban accounting functions (Req 16, 17). Drives the
 * per-number daily cap, the warm-up ramp, randomized send pacing, and the
 * send-window restriction.
 */
export interface AntiBanConfig {
	/** Steady-state per-number daily send cap, reached after the ramp. */
	baseDailyCap: number;
	/** Daily cap held during the first day of the warm-up ramp (Req 16.4). */
	warmupInitialCap: number;
	/** Number of days over which the cap ramps from initial to base. */
	warmupRampDays: number;
	/** Minimum randomized inter-send delay, in milliseconds (Req 17.1). */
	delayMinMs: number;
	/** Maximum randomized inter-send delay, in milliseconds (Req 17.1). */
	delayMaxMs: number;
	/** Local-timezone business-hours window permitting sends (Req 17.4). */
	sendWindow: { startHour: number; endHour: number };
}

/** Per-number anti-ban state read/written by the Anti_Ban_Controller. */
export interface NumberState {
	numberId: string;
	/** Block flag; while set the number sends nothing (Req 18). */
	blocked: boolean;
	/** Messages sent so far in the current day, against the current cap. */
	dailySent: number;
	/** The date the warm-up ramp started, for the day-in-ramp calculation. */
	warmupStartDate: Date;
}

// ---------------------------------------------------------------------------
// Injectable seams for pure timing / pacing functions
// ---------------------------------------------------------------------------

/**
 * Injectable time source. Pure timing functions (cadence/nurture scheduling,
 * send-window checks) take a `Clock` instead of calling `Date.now()` directly,
 * so tests can drive deterministic time.
 */
export interface Clock {
	now(): Date;
}

/**
 * Injectable random-number generator seam: a function returning a float in
 * `[0, 1)` (like `Math.random`). Used by `nextDelayMs(cfg, rng)` so pacing is
 * deterministic under test.
 */
export type Rng = () => number;
