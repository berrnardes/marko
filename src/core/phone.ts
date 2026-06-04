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
