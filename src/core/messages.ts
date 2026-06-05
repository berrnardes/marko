// Message templating (pure, no I/O).
//
// Implements the deterministic Message_Generator per Req 4 (cadence touch
// content) and the design's "Message_Generator (pure selection + render)"
// section:
//
//   interface MessageGenerator {
//     renderTouch(touch: Touch, lead: LeadView): string; // T1..T5 (Req 4.1-4.5)
//     renderNurture(lead: LeadView): string;
//   }
//
// The I/O-bound Cadence_Worker and Nurture_Worker (later tasks) call these pure
// renderers to produce the text they then enqueue through the outbound choke
// point; the renderers themselves touch no I/O. Each touch carries a distinct,
// purpose-built message (Req 4.1-4.5), and the T1 re-opener is personalized
// from the Lead's collected qualification data so two Leads with different data
// produce different T1 text (Req 4.1, 4.7). These functions back the design's
// Property 6 ("Touch templates are distinct and T1 is per-lead personalized").
//
// Everything here is total over its declared domain, has no side effects, and
// performs no I/O: there is no `Date.now()`, no randomness, and no template
// state — the output is a pure function of `(touch, lead view)`. Messages are
// written in Brazilian Portuguese (PT-BR) for the consórcio domain and the
// "Marko" persona, kept simple and deterministic.

import type { LeadView, QualificationFields, Touch } from "./types";

/**
 * The pure Message_Generator surface (design "Message_Generator"): selects and
 * renders the per-touch cadence templates (Req 4.1-4.5) and the monthly nurture
 * message. Exposed both as standalone functions ({@link renderTouch},
 * {@link renderNurture}) and as this object so callers can depend on the
 * interface shape from the design.
 */
export interface MessageGenerator {
	/** Render the message for a cadence touch T1–T5 (Req 4.1-4.5). */
	renderTouch(touch: Touch, lead: LeadView): string;
	/** Render the low-frequency monthly nurture message. */
	renderNurture(lead: LeadView): string;
}

/**
 * Format a numeric amount as a Brazilian-real string (e.g. `50000` →
 * `"R$ 50.000"`), grouping thousands with dots.
 *
 * Kept as a tiny, locale-independent helper rather than `Intl.NumberFormat` so
 * the output is byte-for-byte deterministic across runtimes (no dependence on
 * the host's ICU data). The amount is rounded to a whole number of reais.
 *
 * @param value - The amount in reais (rounded to an integer for display).
 * @returns The grouped BRL string, e.g. `"R$ 50.000"`.
 */
function formatBRL(value: number): string {
	const rounded = Math.round(value);
	const sign = rounded < 0 ? "-" : "";
	const digits = Math.abs(rounded).toString();
	// Insert a "." every three digits from the right (thousands grouping).
	const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
	return `R$ ${sign}${grouped}`;
}

/**
 * Build the greeting prefix, personalized with the Lead's display name when
 * one is known. A `null`, empty, or whitespace-only name falls back to a
 * name-less greeting.
 *
 * @param displayName - The Lead's display name, or `null` when unknown.
 * @returns `"Oi, <name>!"` when a name is present, otherwise `"Oi!"`.
 */
function greet(displayName: string | null): string {
	const name = displayName?.trim();
	return name ? `Oi, ${name}!` : "Oi!";
}

/**
 * Join a list of clauses with PT-BR conjunction style: items separated by
 * commas, with " e " before the final item (`["a", "b", "c"]` → `"a, b e c"`).
 *
 * @param items - The clauses to join.
 * @returns The joined string (empty string for an empty list).
 */
function joinPtBr(items: string[]): string {
	if (items.length === 0) return "";
	if (items.length === 1) return items[0];
	return `${items.slice(0, -1).join(", ")} e ${items[items.length - 1]}`;
}

/**
 * Describe the Lead's collected qualification data as a list of natural PT-BR
 * clauses, including only the fields that are non-null. This is the source of
 * T1's per-lead personalization (Req 4.1, 4.7): because every collected field
 * contributes a clause, two Leads with any difference in their collected data
 * produce a different recap and therefore a different T1 message.
 *
 * @param q - The Lead's progressively-collected qualification fields.
 * @returns Zero or more clauses describing what is known about the Lead.
 */
function describeCollectedData(q: QualificationFields): string[] {
	const facts: string[] = [];
	if (q.segment !== null) {
		facts.push(`tem interesse em consórcio de ${q.segment}`);
	}
	if (q.creditValue !== null) {
		facts.push(`busca um crédito de ${formatBRL(q.creditValue)}`);
	}
	if (q.objective !== null) {
		facts.push(
			q.objective === "housing"
				? "quer conquistar o seu imóvel"
				: "pensa no consórcio como investimento",
		);
	}
	if (q.hasLanceReserve !== null) {
		facts.push(
			q.hasLanceReserve
				? "tem uma reserva para dar de lance"
				: "ainda não tem uma reserva para lance",
		);
	}
	if (q.income !== null) {
		facts.push(`tem uma renda em torno de ${formatBRL(q.income)}`);
	}
	return facts;
}

/**
 * T1 — context re-opener, personalized from the Lead's collected data
 * (Req 4.1, 4.7).
 *
 * The greeting is personalized with the Lead's name when known, and the body
 * recaps whatever qualification data has been collected. When no data has been
 * collected yet the recap falls back to a generic re-engagement line. Because
 * the recap is built from the Lead's fields, the T1 text differs per Lead based
 * on that Lead's collected data (Req 4.7).
 */
function renderT1(lead: LeadView): string {
	const greeting = greet(lead.displayName);
	const facts = describeCollectedData(lead.qualification);
	const recap =
		facts.length === 0
			? "Vi que você demonstrou interesse em consórcio há um tempo e queria retomar essa conversa."
			: `Da última vez, anotei que você ${joinPtBr(facts)}.`;
	return `${greeting} Aqui é o Marko, seu especialista em consórcios. ${recap} Ainda faz sentido a gente continuar de onde paramos?`;
}

/**
 * T2 — value-content message referencing market data (Req 4.2).
 */
function renderT2(lead: LeadView): string {
	const greeting = greet(lead.displayName);
	return `${greeting} É o Marko de novo. Trago um dado de mercado: o consórcio segue como uma das formas mais buscadas de crédito planejado no Brasil, sem juros e com parcelas que cabem no orçamento. Quer que eu te mostre como isso se aplica ao seu caso?`;
}

/**
 * T3 — social-proof message referencing a recent contemplation of a similar
 * profile (Req 4.3). References the Lead's segment when known to make the
 * "similar profile" concrete.
 */
function renderT3(lead: LeadView): string {
	const greeting = greet(lead.displayName);
	const segment = lead.qualification.segment;
	const similar = segment !== null ? ` em consórcio de ${segment}` : "";
	return `${greeting} Aqui é o Marko. Essa semana acompanhei a contemplação de um cliente com um perfil bem parecido com o seu${similar} — foi contemplado e saiu muito satisfeito. Posso te contar rapidinho como foi?`;
}

/**
 * T4 — message offering a fresh simulation, an updated condition, or a free
 * guide (Req 4.4). References the Lead's desired credit value when known.
 */
function renderT4(lead: LeadView): string {
	const greeting = greet(lead.displayName);
	const creditValue = lead.qualification.creditValue;
	const creditClause =
		creditValue !== null ? ` para um crédito de ${formatBRL(creditValue)}` : "";
	return `${greeting} É o Marko. Posso preparar uma simulação nova com as condições atualizadas${creditClause}, ou, se preferir, te enviar um guia gratuito do consórcio. O que te ajuda mais agora?`;
}

/**
 * T5 — breakup message asking whether to remove the Lead from the list or
 * whether continued contact still makes sense (Req 4.5).
 */
function renderT5(lead: LeadView): string {
	const greeting = greet(lead.displayName);
	return `${greeting} É o Marko. Não quero te incomodar, então vou ser direto: prefere que eu te remova da lista, ou ainda faz sentido eu seguir te trazendo novidades sobre consórcio?`;
}

/**
 * The single source of truth mapping each cadence touch to its renderer. Typed
 * as a total map over {@link Touch} so adding or removing a touch is a
 * compile-time concern and {@link renderTouch} stays exhaustive without a
 * runtime fallthrough.
 */
const TOUCH_RENDERERS: { [K in Touch]: (lead: LeadView) => string } = {
	T1: renderT1,
	T2: renderT2,
	T3: renderT3,
	T4: renderT4,
	T5: renderT5,
};

/**
 * Render the message for a cadence touch (Req 4.1-4.5).
 *
 * Selects the per-touch template via {@link TOUCH_RENDERERS} and renders it
 * against the Lead view. The five touch templates are distinct purpose-built
 * messages, and T1 is personalized from the Lead's collected data so it differs
 * per Lead (Req 4.1, 4.7) — backing the design's Property 6.
 *
 * Pure and total over `(Touch, LeadView)`: no I/O, no clock, no randomness.
 *
 * @param touch - The cadence touch to render (T1–T5).
 * @param lead - The narrow Lead view the templates read from.
 * @returns The rendered PT-BR message text.
 */
export function renderTouch(touch: Touch, lead: LeadView): string {
	return TOUCH_RENDERERS[touch](lead);
}

/**
 * Render the low-frequency monthly nurture message for an unresponsive Lead.
 *
 * A light "keeping the door open" check-in that references the Lead's segment
 * when known. Pure and total over `LeadView`: no I/O, no clock, no randomness.
 *
 * @param lead - The narrow Lead view the template reads from.
 * @returns The rendered PT-BR nurture message text.
 */
export function renderNurture(lead: LeadView): string {
	const greeting = greet(lead.displayName);
	const segment = lead.qualification.segment;
	const subjectClause =
		segment !== null ? ` no consórcio de ${segment}` : " no consórcio";
	return `${greeting} É o Marko, passando só para deixar a porta aberta. Quando fizer sentido voltar a pensar${subjectClause}, é só me chamar que retomamos na hora. Seguimos por aqui!`;
}

/**
 * The pure Message_Generator object (design "Message_Generator"), bundling the
 * standalone renderers behind the interface shape. Stateless and safe to share.
 */
export const messageGenerator: MessageGenerator = {
	renderTouch,
	renderNurture,
};
