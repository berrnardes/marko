// Scoring engine (I/O boundary — recompute + persist a Lead's Score/band).
//
// Implements the design's `Scoring_Engine` persistence wrapper: the concrete
// {@link ScoringEngine} the Inbound_Handler depends on (Req 11.1, 12). The
// scoring MATH is the pure `@/core/scoring` (`computeBaseScore`) and
// `@/core/classify` (`classify`); this module only derives the boolean
// {@link ScoringSignals} from a Lead's freshly-read snapshot and persists the
// recomputed `{ score, band }` through the `LeadRepository` interface.
//
// Side-effect boundary: reads the Lead via `LeadRepository.findById` and writes
// the recomputed score/band via `LeadRepository.updateScore` — no other I/O.
// Time and the send-window bounds are injected (a `Clock` and the send-window
// hours) so the derivation stays deterministic and testable.
//
// Signal derivation note (debt: GUIA_ARQUITETURA_COMPLETO §14.2 #5): the base
// score is derived from the Lead's persisted qualification fields plus the
// reply-timing columns on the snapshot. The behavioral bumps (`applyBehavioral`)
// depend on the inbound message text/timing, which `recompute(leadId)` does not
// receive — this engine computes the base score per Req 10 and classifies it
// per Req 12.

import { classify } from "@/core/classify";
import { computeBaseScore } from "@/core/scoring";
import type {
	ClassificationBand,
	Clock,
	LeadSnapshot,
	ScoringSignals,
} from "@/core/types";
import type { LeadRepository } from "@/services/repositories";

/**
 * I/O boundary that recomputes a Lead's Score from its current qualification
 * and behavioral signals and classifies the resulting band (Req 11.1, 12). The
 * Inbound_Handler calls this on every inbound reply; the concrete
 * {@link ScoringEngineService} below wraps the pure `@/core/scoring` functions
 * and the band classifier.
 */
export interface ScoringEngine {
	/**
	 * Recompute and persist the Lead's Score and classification band (Req 11.1,
	 * 12, 19.4), returning the new values.
	 */
	recompute(
		leadId: string,
	): Promise<{ score: number; band: ClassificationBand }>;
}

/** The local business-hours window a reply counts as "in window" for (+5). */
export interface SendWindowHours {
	/** First hour (inclusive, 0–23) the window is open. */
	startHour: number;
	/** Last hour (exclusive, 0–24) the window is open. */
	endHour: number;
}

/** Construction dependencies for {@link ScoringEngineService}. */
export interface ScoringEngineConfig {
	/** Read the Lead snapshot and persist the recomputed score/band (Req 11.1, 19.4). */
	leads: LeadRepository;
	/** Injected time source for the reply-window derivation. */
	clock: Clock;
	/** Local send-window bounds used for the `repliedInSendWindow` signal (Req 10.1). */
	sendWindow: SendWindowHours;
}

/** Tolerated gap for the "replied within 10 minutes" signal, in milliseconds. */
const TEN_MINUTES_MS = 10 * 60 * 1000;

/**
 * Derive the boolean {@link ScoringSignals} from a Lead's freshly-read snapshot
 * (Req 10.1). Pure over its inputs so it can be unit-tested in isolation:
 *
 *   - `allQuestionsAnswered` — every qualification field is filled (Req 9.3).
 *   - `incomeCompatible` / `disqualifying` — both income and credit value are
 *     known and the declared income can plausibly carry the desired credit. A
 *     consórcio installment is roughly `creditValue / term`; with a typical
 *     long term and the common ~30%-of-income affordability ceiling, a credit
 *     value up to ~100× monthly income is treated as compatible. When both
 *     values are known but the credit clearly outstrips the income, the Lead is
 *     `disqualifying` (income incompatible → score forced to 0, Req 10.4).
 *   - `hasLanceReserve` — the Lead holds cash toward a bid (Req 10.1).
 *   - `clearObjective` — housing or investment was stated (Req 10.1).
 *   - `repliedWithin10Min` / `repliedInSendWindow` — derived from the snapshot's
 *     last-inbound/last-outbound timestamps (Req 10.1).
 *   - `mobileNonVoip` — a Brazilian mobile number (13-digit E.164 with the 9th
 *     digit) is treated as a non-VoIP mobile (Req 10.1); VoIP cannot be
 *     distinguished from the number alone, so this is a conservative proxy.
 *
 * @param lead - The freshly-read Lead snapshot.
 * @param sendWindow - The local business-hours window bounds.
 * @returns The boolean scoring signals for {@link computeBaseScore}.
 */
export function deriveScoringSignals(
	lead: LeadSnapshot,
	sendWindow: SendWindowHours,
): ScoringSignals {
	const q = lead.qualification;
	const allQuestionsAnswered =
		q.segment !== null &&
		q.creditValue !== null &&
		q.objective !== null &&
		q.hasLanceReserve !== null &&
		q.income !== null;

	// Affordability check: only decidable when both income and credit value are
	// known. ~100× monthly income is the compatibility ceiling (see JSDoc).
	const bothKnown = q.income !== null && q.creditValue !== null;
	const incomeCompatible =
		bothKnown && (q.income as number) * 100 >= (q.creditValue as number);
	// Income incompatible is a hard disqualifier (Req 10.4); an unknown income
	// is simply "not yet compatible" (low score), never a disqualification.
	const disqualifying = bothKnown && !incomeCompatible;

	let repliedWithin10Min = false;
	let repliedInSendWindow = false;
	if (lead.lastInboundAt) {
		if (lead.lastOutboundAt) {
			const gap = lead.lastInboundAt.getTime() - lead.lastOutboundAt.getTime();
			repliedWithin10Min = gap >= 0 && gap <= TEN_MINUTES_MS;
		}
		const hour = lead.lastInboundAt.getHours();
		repliedInSendWindow =
			hour >= sendWindow.startHour && hour < sendWindow.endHour;
	}

	// BR mobile E.164 is `+55` + 2-digit DDD + `9` + 8 digits = 14 chars incl. `+`.
	const digits = lead.phoneE164.replace(/\D+/g, "");
	const mobileNonVoip =
		digits.startsWith("55") && digits.length === 13 && digits[4] === "9";

	return {
		allQuestionsAnswered,
		incomeCompatible,
		hasLanceReserve: q.hasLanceReserve === true,
		clearObjective: q.objective !== null,
		repliedWithin10Min,
		repliedInSendWindow,
		mobileNonVoip,
		disqualifying,
	};
}

/**
 * Concrete {@link ScoringEngine}: recomputes a Lead's base Score from its
 * persisted signals (Req 11.1) via the pure core, classifies the band (Req 12),
 * and persists both. Stateless beyond its injected dependencies.
 */
export class ScoringEngineService implements ScoringEngine {
	private readonly leads: LeadRepository;
	private readonly clock: Clock;
	private readonly sendWindow: SendWindowHours;

	constructor(deps: ScoringEngineConfig) {
		this.leads = deps.leads;
		this.clock = deps.clock;
		this.sendWindow = deps.sendWindow;
	}

	/** @inheritdoc */
	async recompute(
		leadId: string,
	): Promise<{ score: number; band: ClassificationBand }> {
		const lead = await this.leads.findById(leadId);
		if (!lead) {
			throw new Error(`No lead found for leadId "${leadId}"`);
		}
		// `clock` is read so the seam stays live for future timing-based signals;
		// the current derivation uses the snapshot's own timestamps.
		void this.clock;

		const signals = deriveScoringSignals(lead, this.sendWindow);
		const score = computeBaseScore(signals);
		const band = classify(score);
		await this.leads.updateScore(leadId, score, band);

		// TODO: delete
		console.log(`[SCORING ENGINE] Score: ${score} | Band: ${band}`);
		return { score, band };
	}
}

/** Construct a {@link ScoringEngine} from {@link ScoringEngineConfig}. */
export function createScoringEngine(
	config: ScoringEngineConfig,
): ScoringEngine {
	return new ScoringEngineService(config);
}
