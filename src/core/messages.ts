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
// The messages are stored as editable **templates** with `{placeholder}`
// variables (edited via the CRM "Mensagens" page, persisted in the
// `message_templates` table). The five cadence touches and the monthly nurture
// message each have a built-in default template (`DEFAULT_TEMPLATES`) used when
// the operator has not customized them. Rendering substitutes each placeholder
// with the Lead's value (or a graceful fallback phrase) so the messages stay
// personalized — the T1 re-opener still recaps the Lead's collected data via
// `{resumo}`, so two Leads with different data produce different text (Req 4.1,
// 4.7), backing the design's Property 6.
//
// Everything here is total over its declared domain, has no side effects, and
// performs no I/O: there is no `Date.now()`, no randomness, and no template
// state — `renderTemplate(body, leadView)` is a pure function. Reading the
// stored templates is I/O and lives at the runtime boundary, which feeds them
// into `createMessageGenerator` / `createRefreshableMessageGenerator`. Messages
// are written in Brazilian Portuguese (PT-BR) for the consórcio domain and the
// "Marko" persona.

import type {
	LeadView,
	QualificationFields,
	TemplateKey,
	Touch,
} from "./types";

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

// ---------------------------------------------------------------------------
// Template keys + UI metadata
// ---------------------------------------------------------------------------

/** Every editable template key, in display order (T1–T5 then nurture). */
export const TEMPLATE_KEYS: readonly TemplateKey[] = [
	"T1",
	"T2",
	"T3",
	"T4",
	"T5",
	"nurture",
];

/** Human label + purpose for each template, surfaced in the editing UI. */
export const TEMPLATE_META: Record<
	TemplateKey,
	{ label: string; description: string }
> = {
	T1: {
		label: "T1 — Reabertura",
		description:
			"Primeiro contato que retoma a conversa, personalizado com os dados já coletados do lead.",
	},
	T2: {
		label: "T2 — Conteúdo de valor",
		description: "Mensagem com um dado de mercado sobre consórcio.",
	},
	T3: {
		label: "T3 — Prova social",
		description:
			"Conta sobre a contemplação de um cliente com perfil parecido com o do lead.",
	},
	T4: {
		label: "T4 — Oferta / simulação",
		description:
			"Oferece uma simulação atualizada, condição nova ou um guia gratuito.",
	},
	T5: {
		label: "T5 — Encerramento",
		description:
			"Mensagem de despedida que pergunta se deve remover o lead da lista.",
	},
	nurture: {
		label: "Nurture mensal",
		description:
			"Check-in leve, de baixa frequência, para leads que não responderam.",
	},
};

/**
 * The placeholders an operator may insert into a template, with a short PT-BR
 * description (shown as a legend in the editing UI). Each resolves to the
 * Lead's value when known, otherwise to a graceful fallback phrase.
 */
export const TEMPLATE_PLACEHOLDERS: ReadonlyArray<{
	token: string;
	description: string;
}> = [
	{ token: "{nome}", description: "Primeiro nome do lead (some quando desconhecido)." },
	{
		token: "{resumo}",
		description:
			"Resumo dos dados coletados (ex.: “tem interesse em consórcio de imóveis e busca um crédito de R$ 50.000”).",
	},
	{ token: "{segmento}", description: "Segmento de interesse (ex.: “imóveis”)." },
	{ token: "{credito}", description: "Valor de crédito desejado (ex.: “R$ 50.000”)." },
	{ token: "{objetivo}", description: "Objetivo do lead (ex.: “conquistar o seu imóvel”)." },
	{ token: "{renda}", description: "Renda aproximada (ex.: “R$ 8.000”)." },
];

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Format a numeric amount as a Brazilian-real string (e.g. `50000` →
 * `"R$ 50.000"`), grouping thousands with dots.
 *
 * Kept as a tiny, locale-independent helper rather than `Intl.NumberFormat` so
 * the output is byte-for-byte deterministic across runtimes (no dependence on
 * the host's ICU data). The amount is rounded to a whole number of reais.
 */
function formatBRL(value: number): string {
	const rounded = Math.round(value);
	const sign = rounded < 0 ? "-" : "";
	const digits = Math.abs(rounded).toString();
	const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
	return `R$ ${sign}${grouped}`;
}

/**
 * Join a list of clauses with PT-BR conjunction style: items separated by
 * commas, with " e " before the final item (`["a", "b", "c"]` → `"a, b e c"`).
 */
function joinPtBr(items: string[]): string {
	if (items.length === 0) return "";
	if (items.length === 1) return items[0];
	return `${items.slice(0, -1).join(", ")} e ${items[items.length - 1]}`;
}

/**
 * Describe the Lead's collected qualification data as a list of natural PT-BR
 * clauses, including only the fields that are non-null. This is the source of
 * the `{resumo}` placeholder's per-lead personalization (Req 4.1, 4.7): because
 * every collected field contributes a clause, two Leads with any difference in
 * their collected data produce a different recap.
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
 * Resolve the placeholder values for a Lead. Each placeholder maps to the
 * Lead's value when known, or a graceful fallback phrase so a template reads
 * naturally even when the data is missing — except `{nome}`, which resolves to
 * the empty string and is tidied by {@link cleanup} (so `"Oi, {nome}!"` becomes
 * `"Oi!"` for an unknown name).
 */
function resolveValues(lead: LeadView): Record<string, string> {
	const q = lead.qualification;
	const name = lead.displayName?.trim();
	const facts = describeCollectedData(q);
	const objective =
		q.objective === null
			? "realizar o seu objetivo"
			: q.objective === "housing"
				? "conquistar o seu imóvel"
				: "investir com o consórcio";
	return {
		nome: name && name.length > 0 ? name : "",
		resumo:
			facts.length > 0
				? joinPtBr(facts)
				: "demonstrou interesse em consórcio há um tempo",
		segmento: q.segment ?? "consórcio",
		credito:
			q.creditValue !== null
				? formatBRL(q.creditValue)
				: "um crédito sob medida pra você",
		objetivo: objective,
		renda: q.income !== null ? formatBRL(q.income) : "seu momento atual",
	};
}

/**
 * Tidy a rendered message: drop a comma left dangling before sentence
 * punctuation (e.g. an empty `{nome}` turning `"Oi, !"` into `"Oi!"`), collapse
 * runs of whitespace, and trim. Keeps templates readable when optional values
 * resolve to the empty string.
 */
function cleanup(text: string): string {
	return text
		.replace(/,\s*([!?.,])/g, "$1")
		.replace(/\s{2,}/g, " ")
		.trim();
}

// ---------------------------------------------------------------------------
// Default templates
// ---------------------------------------------------------------------------

/**
 * The built-in default template for each key, used when the operator has not
 * customized it. These reproduce the system's original PT-BR cadence/nurture
 * copy, expressed with the editable placeholders.
 */
export const DEFAULT_TEMPLATES: Record<TemplateKey, string> = {
	T1: "Oi, {nome}! Aqui é o Marko, seu especialista em consórcios. Da última vez, anotei que você {resumo}. Ainda faz sentido a gente continuar de onde paramos?",
	T2: "Oi, {nome}! É o Marko de novo. Trago um dado de mercado: o consórcio segue como uma das formas mais buscadas de crédito planejado no Brasil, sem juros e com parcelas que cabem no orçamento. Quer que eu te mostre como isso se aplica ao seu caso?",
	T3: "Oi, {nome}! Aqui é o Marko. Essa semana acompanhei a contemplação de um cliente interessado em {segmento}, com um perfil bem parecido com o seu — foi contemplado e saiu muito satisfeito. Posso te contar rapidinho como foi?",
	T4: "Oi, {nome}! É o Marko. Posso preparar uma simulação nova com as condições atualizadas para {credito}, ou, se preferir, te enviar um guia gratuito do consórcio. O que te ajuda mais agora?",
	T5: "Oi, {nome}! É o Marko. Não quero te incomodar, então vou ser direto: prefere que eu te remova da lista, ou ainda faz sentido eu seguir te trazendo novidades sobre consórcio?",
	nurture:
		"Oi, {nome}! É o Marko, passando só para deixar a porta aberta. Quando fizer sentido voltar a pensar em {segmento}, é só me chamar que retomamos na hora. Seguimos por aqui!",
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render a template body against a Lead view by substituting every known
 * `{placeholder}` with the Lead's resolved value and tidying the result.
 * Unknown placeholders are left literally in place. Pure and total over
 * `(string, LeadView)`: no I/O, no clock, no randomness.
 *
 * @param body - The template text, with `{placeholder}` variables.
 * @param lead - The narrow Lead view the placeholders read from.
 * @returns The rendered PT-BR message text.
 */
export function renderTemplate(body: string, lead: LeadView): string {
	const values = resolveValues(lead);
	const substituted = body.replace(/\{(\w+)\}/g, (match, key: string) =>
		Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match,
	);
	return cleanup(substituted);
}

/**
 * Build a {@link MessageGenerator} from a (possibly partial) set of stored
 * template bodies, falling back to {@link DEFAULT_TEMPLATES} for any key the
 * operator has not customized. Pure: the returned renderers do no I/O.
 *
 * @param templates - Stored template bodies keyed by {@link TemplateKey}.
 */
export function createMessageGenerator(
	templates: Partial<Record<TemplateKey, string>> = {},
): MessageGenerator {
	const bodyFor = (key: TemplateKey): string =>
		templates[key] ?? DEFAULT_TEMPLATES[key];
	return {
		renderTouch: (touch, lead) => renderTemplate(bodyFor(touch), lead),
		renderNurture: (lead) => renderTemplate(bodyFor("nurture"), lead),
	};
}

/**
 * A {@link MessageGenerator} whose templates can be refreshed in place. The
 * runtime injects the `generator` into the cadence/nurture workers once, then
 * calls `setTemplates` at the start of each job batch with the latest stored
 * templates — so operator edits take effect on the next job without rebuilding
 * the workers. Rendering itself stays pure (it reads the current closure value).
 */
export function createRefreshableMessageGenerator(): {
	generator: MessageGenerator;
	setTemplates: (templates: Partial<Record<TemplateKey, string>>) => void;
} {
	let current: Partial<Record<TemplateKey, string>> = {};
	const bodyFor = (key: TemplateKey): string =>
		current[key] ?? DEFAULT_TEMPLATES[key];
	return {
		generator: {
			renderTouch: (touch, lead) => renderTemplate(bodyFor(touch), lead),
			renderNurture: (lead) => renderTemplate(bodyFor("nurture"), lead),
		},
		setTemplates: (templates) => {
			current = templates;
		},
	};
}

/**
 * The default pure Message_Generator (built-in templates, no customizations).
 * Stateless and safe to share; the standalone {@link renderTouch} /
 * {@link renderNurture} delegate to it.
 */
export const messageGenerator: MessageGenerator = createMessageGenerator();

/** Render a cadence touch with the built-in default templates (Req 4.1-4.5). */
export function renderTouch(touch: Touch, lead: LeadView): string {
	return messageGenerator.renderTouch(touch, lead);
}

/** Render the monthly nurture message with the built-in default template. */
export function renderNurture(lead: LeadView): string {
	return messageGenerator.renderNurture(lead);
}
