// CRM_UI handed-off leads view (Req 13.3, 20.4).
//
// Side-effect boundary: client component. Lists the leads handed off to a
// consultant and, for the selected one, exposes its collected qualification
// data, handoff events, and full conversation history (Req 13.3, 20.4),
// fetched via React Query from the guarded `/api/crm/handoffs` endpoint.

"use client";

import { useState } from "react";

import {
	HandoffEventsCard,
	LeadHeader,
	MessageHistoryCard,
	QualificationCard,
} from "../_components/lead-detail";
import { PageHeader, ScoreBadge, StatusNote } from "../_components/ui";
import { useHandoffs } from "../_lib/api";

export default function HandoffsPage() {
	const { data: leads, isPending, isError, error } = useHandoffs();
	const [selectedId, setSelectedId] = useState<string | null>(null);

	// Derive the effective selection during render (no effect): honor the
	// operator's click when it still points at a listed lead, otherwise default
	// to the first (most recently handed-off) lead.
	const selected =
		(selectedId ? leads?.find((lead) => lead.id === selectedId) : undefined) ??
		leads?.[0] ??
		null;

	return (
		<div>
			<PageHeader
				title="Repasses"
				description="Leads transferidos para um consultor, com seus dados coletados e histórico completo de conversa."
			/>

			{isPending ? <StatusNote>Carregando leads repassados…</StatusNote> : null}
			{isError ? <StatusNote tone="error">{error.message}</StatusNote> : null}

			{leads && leads.length === 0 ? (
				<StatusNote>Nenhum lead foi repassado ainda.</StatusNote>
			) : null}

			{leads && leads.length > 0 ? (
				<div className="grid gap-5 lg:grid-cols-[18rem_1fr]">
					<ul className="flex h-fit flex-col gap-1 rounded-xl bg-card p-2 ring-1 ring-foreground/10">
						{leads.map((lead) => (
							<li key={lead.id}>
								<button
									type="button"
									onClick={() => setSelectedId(lead.id)}
									className={`flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors ${
										lead.id === selected?.id
											? "bg-primary/10 text-primary"
											: "hover:bg-muted"
									}`}
								>
									<span className="font-medium">{lead.phoneE164}</span>
									<ScoreBadge
										score={lead.score}
										band={lead.classificationBand}
									/>
								</button>
							</li>
						))}
					</ul>

					{selected ? (
						<div>
							<LeadHeader lead={selected} />
							<div className="grid gap-5">
								<QualificationCard qualification={selected.qualification} />
								<HandoffEventsCard events={selected.handoffEvents} />
								<MessageHistoryCard messages={selected.messages} />
							</div>
						</div>
					) : null}
				</div>
			) : null}
		</div>
	);
}
