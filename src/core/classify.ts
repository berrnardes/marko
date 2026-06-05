// Score-band classification (pure, no I/O).
//
// Implements the deterministic Score_Based_Classification function per Req 12
// and the design's Property 17 ("Classification partitions the score range
// exactly"): for any score in the inclusive range 0–100, exactly one band is
// returned, and the four bands together exhaust the range with no overlap.
// The function is total over its declared domain, has no side effects, and
// performs no I/O.

/**
 * The score-band classification label returned by {@link classify}.
 *
 * Three of the four labels (`HOT`, `WARM`, `DISQUALIFIED`) coincide with the
 * uppercase {@link LifecycleState} values the Lifecycle_Manager sets on the
 * Lead (Req 12.1, 12.2, 12.4). The lowercase `cold` is intentionally distinct:
 * it is a band label a Lead may carry while it remains in the `QUALIFYING`
 * lifecycle state (Req 12.3, design "Data Models" §classification_band) — it
 * is not a separate lifecycle state, so it is rendered in lowercase to avoid
 * being mistaken for one.
 */
export type ClassificationBand = "HOT" | "WARM" | "cold" | "DISQUALIFIED";

/**
 * Classify a lead score into its score band.
 *
 * The bands partition the inclusive 0–100 score range exactly, with no overlap
 * and no gaps:
 *
 *   - `score >= 70`           → `HOT`           (Req 12.1)
 *   - `40 <= score <= 69`     → `WARM`          (Req 12.2)
 *   - `1  <= score <= 39`     → `cold`          (Req 12.3)
 *   - `score === 0`           → `DISQUALIFIED`  (Req 12.4)
 *
 * The function does not validate or clamp its argument; callers are expected
 * to pass an integer score already in the inclusive range 0–100, as produced
 * by `computeBaseScore` and `applyBehavioral` in `./scoring`. Values outside
 * that range are still classified by the same threshold rules (negatives fall
 * through every positive case and return `DISQUALIFIED`; values above 100
 * return `HOT`), but such inputs indicate a bug in the caller.
 *
 * @param score - The lead's score, expected in the inclusive range 0–100.
 * @returns The band label the score falls into.
 */
export function classify(score: number): ClassificationBand {
	// The order of these checks matters: each branch assumes the prior, more
	// specific bound has already been ruled out, so the inequalities encode
	// each band's lower edge only. The branches are arranged from highest to
	// lowest band so the `HOT` boundary at 70 is checked first.
	if (score >= 70) return "HOT";
	if (score >= 40) return "WARM";
	if (score >= 1) return "cold";
	return "DISQUALIFIED";
}
