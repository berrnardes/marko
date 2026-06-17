// Brazilian-aware phone normalization (pure, no I/O).
//
// Implements `normalizePhone(raw, "BR")` per Req 1.2 and the design's "Phone
// normalization (pure)" section: strips formatting, applies the `+55` country
// code when absent, validates the resulting digit count, and is idempotent
// (`normalizePhone(normalizePhone(x), "BR") === normalizePhone(x, "BR")` for
// every already-normalized `x`). Returns the E.164 string on success and
// `null` when the input cannot be normalized.

/**
 * Normalize a raw Brazilian phone number to E.164 format.
 *
 * Behavior (Req 1.2):
 *   - Strips every non-digit character (spaces, dashes, dots, parentheses,
 *     and a leading or stray `+`).
 *   - Accepts the country code `55` already present (12- or 13-digit input)
 *     and prepends it when absent (10- or 11-digit input), so a Brazilian
 *     number written with or without the country code normalizes the same.
 *   - Validates digit count for Brazilian landline (DDD + 8 local digits =
 *     10 national digits, 12 with country code) and Brazilian mobile (DDD +
 *     9 local digits = 11 national digits, 13 with country code).
 *   - Validates the DDD (area code) is in the inclusive range 11–99.
 *
 * The function is pure and idempotent: feeding its own output back in returns
 * that output unchanged.
 *
 * @param raw - The raw phone number as it appeared in the source (CSV cell,
 *              webhook payload, etc.). Any common Brazilian formatting is
 *              accepted.
 * @param defaultCountry - The country to assume when the country code is
 *              absent from `raw`. Currently only `"BR"` is supported,
 *              matching the deployment's Brazilian operation.
 * @returns The normalized E.164 number (e.g. `"+5511987654321"`), or `null`
 *              when `raw` cannot be normalized to a valid Brazilian phone.
 */
export function normalizePhone(
	raw: string,
	defaultCountry: "BR",
): string | null {
	// `defaultCountry` is currently fixed to "BR"; reading it here keeps the
	// parameter live (so future country support is a non-breaking extension)
	// and documents the assumption against which validation runs.
	void defaultCountry;

	if (typeof raw !== "string") {
		return null;
	}

	// Strip every character that is not a decimal digit. This collapses spaces,
	// dashes, dots, parentheses, and a leading/stray `+` in one pass, which is
	// what makes the function tolerant of common Brazilian input formats.
	const digits = raw.replace(/\D+/g, "");
	if (digits.length === 0) {
		return null;
	}

	// Resolve the national number (DDD + local digits, without the country
	// code) for the four shapes accepted as Brazilian:
	//   13 digits starting with "55" → already includes country code, mobile
	//   12 digits starting with "55" → already includes country code, landline
	//   11 digits                    → national-only, mobile
	//   10 digits                    → national-only, landline
	let national: string;
	if (digits.length === 13 || digits.length === 12) {
		if (!digits.startsWith("55")) {
			return null;
		}
		national = digits.slice(2);
	} else if (digits.length === 11 || digits.length === 10) {
		national = digits;
	} else {
		return null;
	}

	// Validate the DDD (area code). Brazilian DDDs are two digits in the
	// inclusive range 11–99; anything outside that range is malformed and
	// would not address a real region.
	const ddd = Number.parseInt(national.slice(0, 2), 10);
	if (!Number.isFinite(ddd) || ddd < 11 || ddd > 99) {
		return null;
	}

	return `+55${national}`;
}

/**
 * Produce the set of equivalent E.164 forms a Brazilian number may legitimately
 * appear as, to bridge the pre-2012 mobile **9th-digit ambiguity** (Req 1.4,
 * 7.1).
 *
 * The same WhatsApp contact can be addressed both with and without the leading
 * `9` on the subscriber part of a mobile number: a CSV import may carry the
 * modern 11-national-digit form (`+5547996334573`) while WAHA delivers the
 * inbound reply from the legacy 10-national-digit form (`+554796334573`), or
 * vice-versa. Exact-string matching would treat these as two different people
 * and duplicate the Lead, so attribution and dedup must compare against every
 * equivalent form rather than a single canonical string.
 *
 * Behavior:
 *   - The input itself is always included as the first variant, so callers can
 *     use the result as the complete match set.
 *   - For a modern Brazilian mobile (`+55` + DDD + `9` + 8 digits), the legacy
 *     short form (without the leading `9`) is added.
 *   - For a legacy short form whose subscriber begins with a mobile digit
 *     (`6`–`9`), the modern form (with the inserted `9`) is added. Landline
 *     subscribers (leading `2`–`5`) get no `9`-form, since they never carried
 *     the 9th-digit change.
 *   - Non-Brazilian or unrecognized inputs return just the input unchanged.
 *
 * The function is pure and order-stable: the input is always first and the
 * derived variant (when any) second, with duplicates removed.
 *
 * @param e164 - An E.164 number, normally the output of {@link normalizePhone}.
 * @returns The 9th-digit-equivalent E.164 forms to match against, input first.
 */
export function brazilianPhoneVariants(e164: string): string[] {
	if (typeof e164 !== "string") {
		return [];
	}
	const digits = e164.replace(/\D+/g, "");
	// Only Brazilian numbers (country code 55) carry this ambiguity; anything
	// else round-trips unchanged so callers can always use the result as-is.
	if (!digits.startsWith("55")) {
		return [e164];
	}
	const national = digits.slice(2);
	const ddd = national.slice(0, 2);
	const subscriber = national.slice(2);
	const variants = new Set<string>([e164]);

	if (subscriber.length === 9 && subscriber.startsWith("9")) {
		// Modern mobile (DDD + 9 + 8 digits): add the legacy short form by
		// dropping the leading 9 from the subscriber part.
		variants.add(`+55${ddd}${subscriber.slice(1)}`);
	} else if (subscriber.length === 8 && /^[6-9]/.test(subscriber)) {
		// Legacy short mobile form (leading 6–9 marks a mobile, not a landline):
		// add the modern form by inserting the 9th digit after the DDD.
		variants.add(`+55${ddd}9${subscriber}`);
	}

	return [...variants];
}
