// CRM_UI lead detail page (Req 20.2).
//
// Side-effect boundary: client component. When an operator opens a lead, it
// shows the lead's qualification fields and full message history (Req 20.2),
// fetched via React Query from the guarded `/api/crm/leads/[leadId]` endpoint.

"use client";

import Link from "next/link";
import { use } from "react";

import {
	LeadHeader,
	MessageHistoryCard,
	QualificationCard,
} from "../../_components/lead-detail";
import { StatusNote } from "../../_components/ui";
import { useLead } from "../../_lib/api";

export default function LeadDetailPage({
	params,
}: {
	params: Promise<{ leadId: string }>;
}) {
	const { leadId } = use(params);
	const { data: lead, isPending, isError, error } = useLead(leadId);

	return (
		<div>
			<Link href="/crm" className="text-sm text-primary hover:underline">
				← Back to leads
			</Link>

			{isPending ? <StatusNote>Loading lead…</StatusNote> : null}
			{isError ? <StatusNote tone="error">{error.message}</StatusNote> : null}

			{lead ? (
				<div className="mt-4">
					<LeadHeader lead={lead} />
					<div className="grid gap-5 lg:grid-cols-2">
						<QualificationCard qualification={lead.qualification} />
						<MessageHistoryCard messages={lead.messages} />
					</div>
				</div>
			) : null}
		</div>
	);
}
