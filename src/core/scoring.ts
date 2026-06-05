// Lead scoring (pure, no I/O).
//
// Implements the deterministic Scoring_Engine functions per Req 10 and Req 11
// and the design's "Scoring_Engine (pure)" section: a base score from boolean
// qualification signals and an additive behavioral adjustment applied on each
// inbound message during qualification. Both functions are pure, take their
// inputs as plain values, and return an integer in the inclusive range 0–100.

import type { BehavioralSignals, ScoringSignals } from "./types";

/**
 * The point weight added to the base score when each qualification signal
 * holds (Req 10.1). The seven weights sum to exactly 100, so summing only the
 * weights of satisfied signals is naturally bounded in the inclusive range
 * 0–100 (Req 10.2) without a separate clamp.
 */
const BASE_WEIGHTS: {
	[K in Exclude<keyof ScoringSignals, "disqualifying">]: number;
} = {
	allQuestionsAnswered: 20,
	incomeCompatible: 25,
	hasLanceReserve: 20,
	clearObjective: 15,
	repliedWithin10Min: 10,
	repliedInSendWindow: 5,
	mobileNonVoip: 5,
};

/**
 * The point addition each behavioral signal contributes when it holds on an
 * inbound message during qualification (Req 11.2, 11.3, 11.4).
 */
const BEHAVIORAL_WEIGHTS: { [K in keyof BehavioralSignals]: number } = {
	repliedWithin2Min: 10,
	askedAboutGroupsOrLance: 10,
	mentionedUrgentDeadline: 15,
};

/**
 * Compute the base lead score from boolean qualification signals.
 *
 * The score is the sum of the weights whose condition holds, in the inclusive
 * range 0–100 (Req 10.1, 10.2). Two overrides force the score to 0:
 *
 *   - `disqualifying`: the lead's income is incompatible with the desired
 *     value or the lead shows no real interest (Req 10.4). This takes
 *     precedence over every other signal.
 *   - No signal holds at all: the score is 0 (Req 10.3). This already
 *     follows from the empty sum of weights, but is the explicit Req 10.3
 *     case.
 *
 * @param signals - The boolean qualification signals collected for the lead.
 * @returns An integer score in the inclusive range 0–100.
 */
export function computeBaseScore(signals: ScoringSignals): number {
	// Req 10.4: a disqualified lead scores exactly 0, regardless of any other
	// signal that might otherwise contribute weight. Checking this first also
	// short-circuits the sum.
	if (signals.disqualifying) {
		return 0;
	}

	// Sum the weights of the signals that hold. When none hold the sum is 0,
	// satisfying Req 10.3; when all hold the sum is exactly 100, satisfying
	// Req 10.2 without an additional clamp.
	let score = 0;
	if (signals.allQuestionsAnswered) score += BASE_WEIGHTS.allQuestionsAnswered;
	if (signals.incomeCompatible) score += BASE_WEIGHTS.incomeCompatible;
	if (signals.hasLanceReserve) score += BASE_WEIGHTS.hasLanceReserve;
	if (signals.clearObjective) score += BASE_WEIGHTS.clearObjective;
	if (signals.repliedWithin10Min) score += BASE_WEIGHTS.repliedWithin10Min;
	if (signals.repliedInSendWindow) score += BASE_WEIGHTS.repliedInSendWindow;
	if (signals.mobileNonVoip) score += BASE_WEIGHTS.mobileNonVoip;
	return score;
}

/**
 * Apply behavioral additions to a base score and cap the total at 100.
 *
 * Behavioral signals (Req 11.2, 11.3, 11.4) are additive on top of the base
 * score: each signal that holds contributes its weight. The combined total is
 * then capped at 100 (Req 11.5), so the function returns
 * `min(100, base + bonuses)`.
 *
 * The function does not validate the `base` argument's range; callers should
 * pass the value returned by {@link computeBaseScore}, which is already in
 * the inclusive range 0–100.
 *
 * @param base - The base score, expected to be in the inclusive range 0–100.
 * @param behavioral - The boolean behavioral signals from the inbound turn.
 * @returns An integer score in the inclusive range 0–100 (capped).
 */
export function applyBehavioral(
	base: number,
	behavioral: BehavioralSignals,
): number {
	let total = base;
	if (behavioral.repliedWithin2Min)
		total += BEHAVIORAL_WEIGHTS.repliedWithin2Min;
	if (behavioral.askedAboutGroupsOrLance)
		total += BEHAVIORAL_WEIGHTS.askedAboutGroupsOrLance;
	if (behavioral.mentionedUrgentDeadline)
		total += BEHAVIORAL_WEIGHTS.mentionedUrgentDeadline;
	// Req 11.5: cap the post-behavioral score at 100.
	return total > 100 ? 100 : total;
}
