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

import type {
	HandoffLeadView,
	ImportReportView,
	LeadDetailView,
	LeadSummaryView,
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
};

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
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: crmKeys.leads });
		},
	});
}
