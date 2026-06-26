import { describe, expect, it } from "vitest";

import {
	createMessageGenerator,
	DEFAULT_TEMPLATES,
	renderNurture,
	renderTemplate,
	renderTouch,
	TEMPLATE_KEYS,
} from "@/core/messages";
import type { LeadView } from "@/core/types";

/** A lead with no collected data → exercises the fallback paths. */
const EMPTY_LEAD: LeadView = {
	displayName: null,
	qualification: {
		segment: null,
		creditValue: null,
		objective: null,
		hasLanceReserve: null,
		income: null,
	},
};

/** A fully-populated lead → exercises real value substitution. */
const FULL_LEAD: LeadView = {
	displayName: "João",
	qualification: {
		segment: "imóveis",
		creditValue: 50000,
		objective: "housing",
		hasLanceReserve: true,
		income: 8000,
	},
};

describe("renderTemplate", () => {
	it("substitutes known placeholders with the lead's values", () => {
		const out = renderTemplate(
			"Oi, {nome}! Quer {segmento} de {credito}?",
			FULL_LEAD,
		);
		expect(out).toBe("Oi, João! Quer imóveis de R$ 50.000?");
	});

	it("drops a dangling comma when {nome} is empty (Oi, ! -> Oi!)", () => {
		expect(renderTemplate("Oi, {nome}! Tudo bem?", EMPTY_LEAD)).toBe(
			"Oi! Tudo bem?",
		);
	});

	it("falls back gracefully for missing data instead of leaving holes", () => {
		const out = renderTemplate("Pensa em {segmento}?", EMPTY_LEAD);
		expect(out).toBe("Pensa em consórcio?");
		expect(out).not.toContain("{");
	});

	it("leaves unknown placeholders untouched", () => {
		expect(renderTemplate("Valor: {desconhecido}", FULL_LEAD)).toBe(
			"Valor: {desconhecido}",
		);
	});

	it("personalizes {resumo} differently per lead (Req 4.7)", () => {
		const full = renderTemplate("Você {resumo}.", FULL_LEAD);
		const empty = renderTemplate("Você {resumo}.", EMPTY_LEAD);
		expect(full).not.toBe(empty);
		expect(full).toContain("consórcio de imóveis");
	});

	it("renders every default template without leftover tokens", () => {
		for (const key of TEMPLATE_KEYS) {
			const rendered = renderTemplate(DEFAULT_TEMPLATES[key], EMPTY_LEAD);
			expect(rendered).not.toMatch(/\{[a-z]+\}/);
			expect(rendered.length).toBeGreaterThan(0);
		}
	});
});

describe("createMessageGenerator", () => {
	it("uses a provided override and falls back to the default per key", () => {
		const gen = createMessageGenerator({ T1: "Custom {nome}!" });
		expect(gen.renderTouch("T1", FULL_LEAD)).toBe("Custom João!");
		// T2 has no override → default template is used.
		expect(gen.renderTouch("T2", FULL_LEAD)).toBe(
			renderTemplate(DEFAULT_TEMPLATES.T2, FULL_LEAD),
		);
	});

	it("default standalone renderers match the default-template generator", () => {
		expect(renderTouch("T3", FULL_LEAD)).toBe(
			renderTemplate(DEFAULT_TEMPLATES.T3, FULL_LEAD),
		);
		expect(renderNurture(FULL_LEAD)).toBe(
			renderTemplate(DEFAULT_TEMPLATES.nurture, FULL_LEAD),
		);
	});
});
