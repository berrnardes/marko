// CRM_UI lead list (Req 20.1).
//
// Side-effect boundary: client component. Lists every lead with its lifecycle
// state and score (Req 20.1), fetched via React Query from the guarded
// `/api/crm/leads` endpoint. Each row links to the lead detail view.

"use client";

import Link from "next/link";

import {
	LifecycleBadge,
	PageHeader,
	ScoreBadge,
	StatusNote,
} from "./_components/ui";
import { useLeads } from "./_lib/api";
import { formatDateTime } from "./_lib/format";

export default function LeadListPage() {
	const { data: leads, isPending, isError, error } = useLeads();

	return (
		<div>
			<PageHeader
				title="Leads"
				description="Todos os leads com seu estado de ciclo de vida e pontuação atuais."
			/>

			{isPending ? <StatusNote>Carregando leads…</StatusNote> : null}
			{isError ? <StatusNote tone="error">{error.message}</StatusNote> : null}

			{leads && leads.length === 0 ? (
				<StatusNote>Nenhum lead ainda. Importe um CSV para começar.</StatusNote>
			) : null}

			{leads && leads.length > 0 ? (
				<div className="overflow-hidden rounded-lg border border-ink/10 bg-surface-card shadow-sm">
					<table className="w-full text-left text-sm">
						<thead className="border-b border-ink/10 bg-surface/60 text-xs uppercase tracking-wide text-ink/50">
							<tr>
								<th className="px-4 py-3 font-medium">Telefone</th>
								<th className="px-4 py-3 font-medium">Origem</th>
								<th className="px-4 py-3 font-medium">Estado</th>
								<th className="px-4 py-3 font-medium">Pontuação</th>
								<th className="px-4 py-3 font-medium">Atualizado</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-ink/5">
							{leads.map((lead) => (
								<tr
									key={lead.id}
									className="transition-colors hover:bg-surface/50"
								>
									<td className="px-4 py-3">
										<Link
											href={`/crm/leads/${lead.id}`}
											className="font-medium text-primary hover:underline"
										>
											{lead.phoneE164}
										</Link>
									</td>
									<td className="px-4 py-3 text-ink/70">{lead.source}</td>
									<td className="px-4 py-3">
										<LifecycleBadge state={lead.lifecycleState} />
									</td>
									<td className="px-4 py-3">
										<ScoreBadge
											score={lead.score}
											band={lead.classificationBand}
										/>
									</td>
									<td className="px-4 py-3 text-ink/50">
										{formatDateTime(lead.updatedAt)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : null}
		</div>
	);
}
