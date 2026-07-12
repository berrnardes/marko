// CRM_UI client data hooks (task 22.3).
//
// Side-effect boundary: client-only. Thin React Query hooks over the guarded
// internal `/api/crm/*` endpoints that feed the lead list (Req 20.1), lead
// detail (Req 20.2), handed-off leads view (Req 13.3, 20.4), and CSV import
// (Req 20.3). Each hook owns its query key and fetcher; components consume the
// returned view DTOs (`./types`) and never call `fetch` directly.

"use client";

import {
	useMutation,
	useQuery,
	useQueryClient,
	type UseMutationResult,
	type UseQueryResult,
} from "@tanstack/react-query";
import { toast } from "sonner";

import type {
	HandoffLeadView,
	ImportReportView,
	LeadDetailView,
	LeadSummaryView,
	NotificationSettingsView,
	NumberView,
	SessionStatusView,
	TemplatesResponse,
	TemplateView,
} from "./types";

/** Read JSON from a guarded endpoint, throwing a readable error on failure. */
async function getJson<T>(url: string): Promise<T> {
	const response = await fetch(url, { credentials: "same-origin" });
	if (!response.ok) {
		if (response.status === 401) {
			throw new Error("Your session has expired. Please sign in again.");
		}
		throw new Error(`Request failed (${response.status})`);
	}
	return (await response.json()) as T;
}

/** Query keys for the CRM read endpoints. */
export const crmKeys = {
	leads: ["crm", "leads"] as const,
	lead: (leadId: string) => ["crm", "lead", leadId] as const,
	handoffs: ["crm", "handoffs"] as const,
	numbers: ["crm", "numbers"] as const,
	templates: ["crm", "templates"] as const,
	session: (sessionName: string) => ["crm", "session", sessionName] as const,
	settings: ["crm", "settings"] as const,
};

/** POST/PATCH JSON to a guarded endpoint, surfacing the API's `error` detail. */
async function sendJson<T>(
	url: string,
	method: "POST" | "PATCH",
	payload?: unknown,
): Promise<T> {
	const response = await fetch(url, {
		method,
		headers: payload === undefined ? {} : { "Content-Type": "application/json" },
		body: payload === undefined ? undefined : JSON.stringify(payload),
		credentials: "same-origin",
	});
	if (!response.ok) {
		const detail = (await response.json().catch(() => null)) as {
			error?: string;
		} | null;
		throw new Error(detail?.error ?? `Request failed (${response.status})`);
	}
	return (await response.json()) as T;
}

/** Fetch the lead list — lifecycle state + score per lead (Req 20.1). */
export function useLeads(): UseQueryResult<LeadSummaryView[]> {
	return useQuery({
		queryKey: crmKeys.leads,
		queryFn: async () => {
			const data = await getJson<{ leads: LeadSummaryView[] }>(
				"/api/crm/leads",
			);
			return data.leads;
		},
	});
}

/** Fetch a single lead's qualification fields and message history (Req 20.2). */
export function useLead(leadId: string): UseQueryResult<LeadDetailView> {
	return useQuery({
		queryKey: crmKeys.lead(leadId),
		queryFn: async () => {
			const data = await getJson<{ lead: LeadDetailView }>(
				`/api/crm/leads/${encodeURIComponent(leadId)}`,
			);
			return data.lead;
		},
	});
}

/** Fetch the handed-off leads with collected data + history (Req 13.3, 20.4). */
export function useHandoffs(): UseQueryResult<HandoffLeadView[]> {
	return useQuery({
		queryKey: crmKeys.handoffs,
		queryFn: async () => {
			const data = await getJson<{ leads: HandoffLeadView[] }>(
				"/api/crm/handoffs",
			);
			return data.leads;
		},
	});
}

/**
 * Upload a CSV and return the import result report (Req 20.3). On success the
 * lead list cache is invalidated so it reflects newly-created leads.
 */
export function useImportCsv(): UseMutationResult<
	ImportReportView,
	Error,
	File
> {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (file: File) => {
			const form = new FormData();
			form.append("file", file);
			const response = await fetch("/api/crm/import", {
				method: "POST",
				body: form,
				credentials: "same-origin",
			});
			if (!response.ok) {
				const detail = (await response.json().catch(() => null)) as {
					error?: string;
				} | null;
				throw new Error(detail?.error ?? `Import failed (${response.status})`);
			}
			const data = (await response.json()) as { report: ImportReportView };
			return data.report;
		},
		onSuccess: (report) => {
			void queryClient.invalidateQueries({ queryKey: crmKeys.leads });
			toast.success("Importação concluída", {
				description: `${report.createdCount} criados · ${report.updatedCount} atualizados · ${report.rejectedCount} rejeitados`,
			});
		},
		onError: (error) => toast.error(error.message),
	});
}

// ---------------------------------------------------------------------------
// WhatsApp numbers management
// ---------------------------------------------------------------------------

/** Fetch all WhatsApp numbers (including blocked). */
export function useNumbers(): UseQueryResult<NumberView[]> {
	return useQuery({
		queryKey: crmKeys.numbers,
		queryFn: async () => {
			const data = await getJson<{ numbers: NumberView[] }>("/api/crm/numbers");
			return data.numbers;
		},
	});
}

/** Create a new WhatsApp number. */
export function useCreateNumber(): UseMutationResult<
	NumberView,
	Error,
	{ sessionName: string; msisdn: string }
> {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (payload: { sessionName: string; msisdn: string }) => {
			const response = await fetch("/api/crm/numbers", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
				credentials: "same-origin",
			});
			if (!response.ok) {
				const detail = (await response.json().catch(() => null)) as {
					error?: string;
				} | null;
				throw new Error(
					detail?.error ?? `Failed to create number (${response.status})`,
				);
			}
			const data = (await response.json()) as { number: NumberView };
			return data.number;
		},
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: crmKeys.numbers });
		},
	});
}

/** Toggle the block flag on a WhatsApp number. */
export function useToggleNumberBlock(): UseMutationResult<
	void,
	Error,
	{ numberId: string; blocked: boolean }
> {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async ({
			numberId,
			blocked,
		}: {
			numberId: string;
			blocked: boolean;
		}) => {
			const response = await fetch(
				`/api/crm/numbers/${encodeURIComponent(numberId)}`,
				{
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ blocked }),
					credentials: "same-origin",
				},
			);
			if (!response.ok) {
				const detail = (await response.json().catch(() => null)) as {
					error?: string;
				} | null;
				throw new Error(
					detail?.error ?? `Failed to update number (${response.status})`,
				);
			}
		},
		onSuccess: (_data, variables) => {
			void queryClient.invalidateQueries({ queryKey: crmKeys.numbers });
			toast.success(
				variables.blocked ? "Número bloqueado" : "Número desbloqueado",
			);
		},
		onError: (error) => toast.error(error.message),
	});
}

// ---------------------------------------------------------------------------
// WhatsApp session onboarding (QR connect flow)
// ---------------------------------------------------------------------------

/** Create + start a fresh WAHA session; returns its generated name. */
export function useCreateSession(): UseMutationResult<
	{ sessionName: string; status: string },
	Error,
	void
> {
	return useMutation({
		mutationFn: async () => {
			const response = await fetch("/api/crm/numbers/sessions", {
				method: "POST",
				credentials: "same-origin",
			});
			if (!response.ok) {
				const detail = (await response.json().catch(() => null)) as {
					error?: string;
				} | null;
				throw new Error(
					detail?.error ?? `Failed to start session (${response.status})`,
				);
			}
			return (await response.json()) as { sessionName: string; status: string };
		},
	});
}

/**
 * Poll a session's status + QR while the connect panel is open. Polls every 2s
 * until the session is WORKING or FAILED (then stops). Disabled when
 * `sessionName` is null (no session in progress).
 */
export function useSessionStatus(
	sessionName: string | null,
): UseQueryResult<SessionStatusView> {
	return useQuery({
		queryKey: crmKeys.session(sessionName ?? "none"),
		enabled: sessionName !== null,
		refetchInterval: (query) => {
			const status = query.state.data?.status;
			return status === "WORKING" || status === "FAILED" ? false : 2000;
		},
		queryFn: async () =>
			getJson<SessionStatusView>(
				`/api/crm/numbers/sessions/${encodeURIComponent(sessionName ?? "")}`,
			),
	});
}

/**
 * Confirm a connected session: persists the number (msisdn read server-side
 * from WAHA) and refreshes the numbers list.
 */
export function useConfirmSession(): UseMutationResult<
	NumberView,
	Error,
	string
> {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (sessionName: string) => {
			const response = await fetch(
				`/api/crm/numbers/sessions/${encodeURIComponent(sessionName)}/confirm`,
				{ method: "POST", credentials: "same-origin" },
			);
			if (!response.ok) {
				const detail = (await response.json().catch(() => null)) as {
					error?: string;
				} | null;
				throw new Error(
					detail?.error ?? `Failed to confirm session (${response.status})`,
				);
			}
			const data = (await response.json()) as { number: NumberView };
			return data.number;
		},
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: crmKeys.numbers });
			toast.success("Número conectado");
		},
	});
}

/** Tear down a pending (unconfirmed) session when the connect panel is closed. */
export function useCancelSession(): UseMutationResult<void, Error, string> {
	return useMutation({
		mutationFn: async (sessionName: string) => {
			await fetch(
				`/api/crm/numbers/sessions/${encodeURIComponent(sessionName)}`,
				{ method: "DELETE", credentials: "same-origin" },
			);
		},
	});
}

/** Delete a WhatsApp number. */
export function useDeleteNumber(): UseMutationResult<void, Error, string> {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (numberId: string) => {
			const response = await fetch(
				`/api/crm/numbers/${encodeURIComponent(numberId)}`,
				{
					method: "DELETE",
					credentials: "same-origin",
				},
			);
			if (!response.ok) {
				const detail = (await response.json().catch(() => null)) as {
					error?: string;
				} | null;
				throw new Error(
					detail?.error ?? `Failed to delete number (${response.status})`,
				);
			}
		},
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: crmKeys.numbers });
			toast.success("Número removido");
		},
		onError: (error) => toast.error(error.message),
	});
}

// ---------------------------------------------------------------------------
// Notification settings (handoff alerts)
// ---------------------------------------------------------------------------

/** Fetch the signed-in member's handoff-alert settings. */
export function useNotificationSettings(): UseQueryResult<NotificationSettingsView> {
	return useQuery({
		queryKey: crmKeys.settings,
		queryFn: async () => {
			const data = await getJson<{ settings: NotificationSettingsView }>(
				"/api/crm/settings/notifications",
			);
			return data.settings;
		},
	});
}

/** Save the alert phone and send its WhatsApp verification code (also resend). */
export function useSetAlertPhone(): UseMutationResult<
	{ phoneE164: string; expiresAt: string },
	Error,
	string
> {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (phone: string) =>
			sendJson<{ phoneE164: string; expiresAt: string }>(
				"/api/crm/settings/phone",
				"POST",
				{ phone },
			),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: crmKeys.settings });
			toast.success("Código enviado", {
				description: "Confira o WhatsApp e digite o código de 6 dígitos.",
			});
		},
		onError: (error) => toast.error(error.message),
	});
}

/** Confirm the alert phone with the received 6-digit code. */
export function useVerifyAlertPhone(): UseMutationResult<
	{ ok: true; phoneE164: string },
	Error,
	string
> {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (code: string) =>
			sendJson<{ ok: true; phoneE164: string }>(
				"/api/crm/settings/phone/verify",
				"POST",
				{ code },
			),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: crmKeys.settings });
			toast.success("WhatsApp verificado");
		},
		onError: (error) => toast.error(error.message),
	});
}

/** Toggle the per-membership handoff-alert opt-in flag. */
export function useToggleHandoffAlerts(): UseMutationResult<
	{ ok: true },
	Error,
	boolean
> {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (receivesHandoffAlerts: boolean) =>
			sendJson<{ ok: true }>("/api/crm/settings/notifications", "PATCH", {
				receivesHandoffAlerts,
			}),
		onSuccess: (_data, receivesHandoffAlerts) => {
			void queryClient.invalidateQueries({ queryKey: crmKeys.settings });
			toast.success(
				receivesHandoffAlerts ? "Alertas ativados" : "Alertas desativados",
			);
		},
		onError: (error) => toast.error(error.message),
	});
}

/** Send a sample handoff alert to the caller's verified phone. */
export function useSendTestAlert(): UseMutationResult<
	{ ok: true },
	Error,
	void
> {
	return useMutation({
		mutationFn: () =>
			sendJson<{ ok: true }>("/api/crm/settings/test-alert", "POST"),
		onSuccess: () =>
			toast.success("Alerta de teste enviado", {
				description: "Confira o seu WhatsApp.",
			}),
		onError: (error) => toast.error(error.message),
	});
}

// ---------------------------------------------------------------------------
// Cadence / nurture message templates
// ---------------------------------------------------------------------------

/** Fetch the editable message templates (T1–T5 + nurture) and placeholders. */
export function useTemplates(): UseQueryResult<TemplatesResponse> {
	return useQuery({
		queryKey: crmKeys.templates,
		queryFn: async () => getJson<TemplatesResponse>("/api/crm/templates"),
	});
}

/** Save (customize) a template's body. */
export function useSaveTemplate(): UseMutationResult<
	TemplateView,
	Error,
	{ key: string; body: string }
> {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (payload: { key: string; body: string }) => {
			const response = await fetch("/api/crm/templates", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
				credentials: "same-origin",
			});
			if (!response.ok) {
				const detail = (await response.json().catch(() => null)) as {
					error?: string;
				} | null;
				throw new Error(
					detail?.error ?? `Failed to save template (${response.status})`,
				);
			}
			const data = (await response.json()) as { template: TemplateView };
			return data.template;
		},
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: crmKeys.templates });
			toast.success("Modelo salvo");
		},
		onError: (error) => toast.error(error.message),
	});
}

/** Restore a template to its built-in default (deletes the stored row). */
export function useResetTemplate(): UseMutationResult<
	TemplateView,
	Error,
	string
> {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (key: string) => {
			const response = await fetch(
				`/api/crm/templates?key=${encodeURIComponent(key)}`,
				{ method: "DELETE", credentials: "same-origin" },
			);
			if (!response.ok) {
				const detail = (await response.json().catch(() => null)) as {
					error?: string;
				} | null;
				throw new Error(
					detail?.error ?? `Failed to reset template (${response.status})`,
				);
			}
			const data = (await response.json()) as { template: TemplateView };
			return data.template;
		},
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: crmKeys.templates });
			toast.success("Modelo restaurado para o padrão");
		},
		onError: (error) => toast.error(error.message),
	});
}
