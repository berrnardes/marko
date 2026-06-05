// PT-BR opt-out phrase detection (pure, no I/O).
//
// Implements the deterministic `detectOptOut` predicate per Req 15.1 and the
// design's "Compliance_Manager (pure detection + persistence)" section
// (`function detectOptOut(text: string): boolean; // pure (PT-BR opt-out
// phrases)`). The I/O-bound `ComplianceManager.applyOptOut` (a later task)
// wraps this pure check with persistence: when this predicate returns `true`
// for an inbound message, the lead's `Opt_In_Status` is set to `opt_out`, the
// lead is transitioned to `OPTED_OUT`, and all scheduled outreach is cancelled
// (Req 15.1–15.3). This detector contributes to the design's Property 20
// ("Opt-out is detected, recorded, and immediately silences all outreach").
//
// The function is total over its declared domain, has no side effects, and
// performs no I/O.

/**
 * The canonical set of Brazilian-Portuguese opt-out expressions — the single
 * source of truth for what counts as an opt-out request (Req 15.1). Add new
 * expressions here and the detector picks them up automatically.
 *
 * Phrases are written in natural, human-readable PT-BR (accents included) for
 * maintainability; {@link detectOptOut} normalizes both these phrases and the
 * inbound text the same way before matching, so accent and casing differences
 * (e.g. "PARE", "pare", "páre") are irrelevant at match time. Matching is
 * whole-word/phrase aware (see {@link detectOptOut}), so a short phrase such as
 * `"pare"` does not match incidentally inside an unrelated longer word like
 * `"parente"`.
 *
 * The set intentionally includes a few very common single-word requests
 * (`"pare"`, `"sair"`, the English `"stop"`) used in Brazilian WhatsApp
 * opt-out conventions. Because they are matched as whole words, the
 * false-positive surface is limited to messages that use exactly those words.
 */
export const OPT_OUT_PHRASES: readonly string[] = [
	// Stop / "pare" family.
	"pare",
	"parar",
	"pode parar",
	"para de mandar",
	"para de mandar mensagem",
	"parar de receber",
	"parar de receber mensagens",
	"parar de receber mensagem",
	// "Not interested" family.
	"nao quero mais",
	"nao quero mais mensagens",
	"nao quero mais mensagem",
	"nao quero mais contato",
	"nao tenho interesse",
	"sem interesse",
	"perdi o interesse",
	// "Don't message me" family.
	"nao me mande mais",
	"nao me mande mais mensagens",
	"nao me envie mais",
	"nao envie mais",
	"nao envie mais mensagens",
	"nao manda mais",
	"nao manda mais mensagem",
	// Unsubscribe / remove-from-list family.
	"descadastrar",
	"descadastre",
	"descadastrar me",
	"cancelar",
	"cancela",
	"cancelar inscricao",
	"remover da lista",
	"me remova",
	"me remova da lista",
	"remover",
	"me tira da lista",
	"me tire da lista",
	"sair da lista",
	"me exclua",
	"me exclua da lista",
	"exclua meu numero",
	"remover meu numero",
	"remover meu numero da lista",
	"apague meu numero",
	// "Leave me alone" family.
	"nao perturbe",
	"nao perturbar",
	"me deixa em paz",
	"me deixe em paz",
	"para de me perturbar",
	// Common single-word / English-in-BR conventions.
	"sair",
	"stop",
];

/**
 * Normalize free text into a canonical, accent- and case-insensitive form for
 * whole-word matching.
 *
 * The steps are, in order:
 *   1. Decompose to Unicode NFD so accented letters split into a base letter
 *      plus combining marks (e.g. "á" → "a" + U+0301).
 *   2. Strip the combining diacritical marks (U+0300–U+036F), folding accented
 *      letters onto their base ASCII letter ("páre" → "pare", "ç" → "c").
 *   3. Lowercase, so casing is irrelevant ("PARE" → "pare").
 *   4. Replace every run of non-alphanumeric characters with a single space and
 *      trim, collapsing punctuation/whitespace so token boundaries are uniform.
 *
 * The result is a string of space-separated lowercase ASCII tokens. Wrapping it
 * in single spaces (done by the caller) lets a phrase be tested for whole-word
 * containment with a plain substring check.
 *
 * @param text - Arbitrary inbound text.
 * @returns The normalized, space-delimited token string (possibly empty).
 */
function normalize(text: string): string {
	return text
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

/**
 * Pre-normalized opt-out phrases, each padded with a single leading and
 * trailing space. Padding both the haystack and each needle with spaces turns
 * a substring test into a whole-word/phrase test: `" pare "` is a substring of
 * `" pode parar "`? no; of `" quero que pare agora "`? yes; of
 * `" parente "`? no. Computed once at module load from {@link OPT_OUT_PHRASES}.
 */
const NORMALIZED_OPT_OUT_NEEDLES: readonly string[] = OPT_OUT_PHRASES.map(
	(phrase) => ` ${normalize(phrase)} `,
);

/**
 * Detect whether an inbound message expresses an opt-out request (Req 15.1).
 *
 * The text is normalized (accent-folded, lowercased, punctuation collapsed; see
 * {@link normalize}) and then tested for a whole-word/phrase occurrence of any
 * expression in {@link OPT_OUT_PHRASES}. Matching is whole-word aware: the
 * normalized text is wrapped in spaces and each normalized phrase is likewise
 * space-padded, so a phrase only matches on token boundaries and never as an
 * incidental substring of a longer word (e.g. `"pare"` does not match inside
 * `"parente"` or `"comparecer"`).
 *
 * Pure, total, and deterministic: it depends only on `text` and the static
 * phrase list, performs no I/O, and has no side effects. Non-string and empty
 * inputs are treated as "no opt-out" and return `false`.
 *
 * @param text - The inbound message text to inspect.
 * @returns `true` if the message expresses an opt-out request, else `false`.
 */
export function detectOptOut(text: string): boolean {
	if (typeof text !== "string" || text.length === 0) {
		return false;
	}

	const normalized = normalize(text);
	if (normalized.length === 0) {
		return false;
	}

	// Wrap the haystack in spaces so space-padded needles match on word
	// boundaries (including the first and last token).
	const haystack = ` ${normalized} `;
	return NORMALIZED_OPT_OUT_NEEDLES.some((needle) => haystack.includes(needle));
}
