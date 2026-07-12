// CRM_UI lead list (Req 20.1).
//
// Side-effect boundary: client component. Lists every lead with its lifecycle
// state and score (Req 20.1), fetched via React Query from the guarded
// `/api/crm/leads` endpoint. Each row links to the lead detail view.

"use client";

import Link from "next/link";

import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";

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
				<div className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Telefone</TableHead>
								<TableHead>Origem</TableHead>
								<TableHead>Estado</TableHead>
								<TableHead>Pontuação</TableHead>
								<TableHead>Atualizado</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{leads.map((lead) => (
								<TableRow key={lead.id}>
									<TableCell>
										<Link
											href={`/crm/leads/${lead.id}`}
											className="font-medium text-primary hover:underline"
										>
											{lead.phoneE164}
										</Link>
									</TableCell>
									<TableCell className="text-muted-foreground">
										{lead.source}
									</TableCell>
									<TableCell>
										<LifecycleBadge state={lead.lifecycleState} />
									</TableCell>
									<TableCell>
										<ScoreBadge
											score={lead.score}
											band={lead.classificationBand}
										/>
									</TableCell>
									<TableCell className="text-muted-foreground">
										{formatDateTime(lead.updatedAt)}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			) : null}
		</div>
	);
}
