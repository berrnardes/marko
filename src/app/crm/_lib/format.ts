// CRM_UI formatting helpers (task 22.3).
//
// Pure presentation utilities shared by the CRM pages: timestamp and currency
// formatting and qualification-field labelling. No I/O, no React.

import type { LifecycleState } from "@/core/types";

/** Format an ISO-8601 timestamp for display in the operator's locale. */
export function formatDateTime(iso: string): string {
	return new Date(iso).toLocaleString("pt-BR", {
		dateStyle: "short",
		timeStyle: "short",
	});
}

/** Format a BRL amount, or an em dash when the value is absent. */
export function formatCurrency(value: number | null): string {
	if (value === null) {
		return "—";
	}
	return value.toLocaleString("pt-BR", {
		style: "currency",
		currency: "BRL",
		maximumFractionDigits: 0,
	});
}

/** Render a nullable boolean qualification flag as Sim / Não / em dash. */
export function formatBoolean(value: boolean | null): string {
	if (value === null) {
		return "—";
	}
	return value ? "Sim" : "Não";
}

/** Render a nullable string field, falling back to an em dash. */
export function formatText(value: string | null): string {
	return value && value.trim().length > 0 ? value : "—";
}

/** Human-readable labels for the seven lifecycle states (ADR-003). */
export const LIFECYCLE_LABELS: Record<LifecycleState, string> = {
	QUEUED: "Na fila",
	IN_CADENCE: "Em cadência",
	REPLIED: "Respondeu",
	COMPLETED: "Cadência concluída",
	WON: "Ganho",
	LOST: "Perdido",
	OPTED_OUT: "Optou por sair",
};
