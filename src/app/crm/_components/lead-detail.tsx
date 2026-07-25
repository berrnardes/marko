// CRM_UI lead detail panels (task 22.3, Req 20.2, 20.4).
//
// Building blocks shared by the lead detail page and the handed-off leads view:
// the lead identity header, the consultant's state controls, the collected
// qualification fields, and the conversation history. Data is fetched by the
// pages and passed in; the one exception is {@link LeadStateActions}, which owns
// its own mutations because it writes rather than displays.

"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";

import { useReenqueueLead, useSetLeadState } from "../_lib/api";
import {
	formatBoolean,
	formatCurrency,
	formatDateTime,
	formatText,
} from "../_lib/format";
import type {
	HandoffEventView,
	LeadDetailView,
	MessageView,
	QualificationView,
} from "../_lib/types";
import { LifecycleBadge } from "./ui";

/** Identity + status header for a lead (phone, source, state). */
export function LeadHeader({ lead }: { lead: LeadDetailView }) {
	return (
		<div className="mb-6 flex flex-wrap items-center gap-3">
			<h1 className="font-heading text-2xl font-semibold text-foreground">
				{lead.phoneE164}
			</h1>
			<LifecycleBadge state={lead.lifecycleState} />
			<span className="text-sm text-muted-foreground">via {lead.source}</span>
			{lead.optInStatus === "opt_out" ? (
				<Badge variant="outline" className="text-muted-foreground">
					Optou por sair
				</Badge>
			) : null}
			{lead.blocked ? <Badge variant="destructive">Bloqueado</Badge> : null}
		</div>
	);
}

/**
 * The consultant's controls over the lead's state (ADR-003 rules 4–5).
 *
 * Deliberately state-dependent rather than a generic dropdown of all seven
 * states: at any moment there are at most two sensible moves, and showing the
 * others would invite a `409` from the server for no gain. `OPTED_OUT` never
 * appears — that is the lead's decision, not the consultant's, and it has to go
 * through the compliance path.
 */
export function LeadStateActions({ lead }: { lead: LeadDetailView }) {
	const setState = useSetLeadState();
	const reenqueue = useReenqueueLead();
	const busy = setState.isPending || reenqueue.isPending;

	const actions: {
		label: string;
		hint: string;
		run: () => void;
		variant?: React.ComponentProps<typeof Button>["variant"];
	}[] = [];

	if (lead.lifecycleState === "REPLIED") {
		actions.push(
			{
				label: "Marcar como ganho",
				hint: "O lead fechou negócio.",
				run: () =>
					setState.mutate({ leadId: lead.id, lifecycleState: "WON" }),
			},
			{
				label: "Marcar como perdido",
				hint: "Não vai fechar.",
				variant: "outline",
				run: () =>
					setState.mutate({ leadId: lead.id, lifecycleState: "LOST" }),
			},
		);
	}

	// Undo a mis-click: both outcomes step back through REPLIED.
	if (lead.lifecycleState === "WON" || lead.lifecycleState === "LOST") {
		actions.push({
			label: "Reabrir atendimento",
			hint: "Desfaz o desfecho e devolve o lead para “Respondeu”.",
			variant: "outline",
			run: () =>
				setState.mutate({ leadId: lead.id, lifecycleState: "REPLIED" }),
		});
	}

	if (lead.lifecycleState === "COMPLETED") {
		actions.push({
			label: "Recolocar na cadência",
			hint: "Agenda os cinco toques novamente, do começo.",
			variant: "outline",
			run: () => reenqueue.mutate(lead.id),
		});
	}

	if (actions.length === 0) {
		return null;
	}

	return (
		<div className="mb-6 flex flex-wrap items-center gap-2">
			{actions.map((action) => (
				<Button
					key={action.label}
					size="sm"
					variant={action.variant}
					disabled={busy}
					title={action.hint}
					onClick={action.run}
				>
					{action.label}
				</Button>
			))}
		</div>
	);
}

/** A single label/value row inside the qualification card. */
function Field({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex flex-col gap-0.5">
			<dt className="text-xs uppercase tracking-wide text-muted-foreground">
				{label}
			</dt>
			<dd className="text-sm text-foreground">{value}</dd>
		</div>
	);
}

/** The collected qualification fields, nullable values shown as em dashes (Req 20.2). */
export function QualificationCard({
	qualification,
}: {
	qualification: QualificationView;
}) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>Qualificação</CardTitle>
			</CardHeader>
			<CardContent>
				<dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
					<Field label="Segmento" value={formatText(qualification.segment)} />
					<Field
						label="Valor do crédito"
						value={formatCurrency(qualification.creditValue)}
					/>
					<Field label="Objetivo" value={formatText(qualification.objective)} />
					<Field
						label="Reserva de lance"
						value={formatBoolean(qualification.hasLanceReserve)}
					/>
					<Field label="Renda" value={formatCurrency(qualification.income)} />
				</dl>
			</CardContent>
		</Card>
	);
}

/** A single message bubble, aligned by direction. */
function MessageBubble({ message }: { message: MessageView }) {
	const inbound = message.direction === "inbound";
	return (
		<li className={`flex ${inbound ? "justify-start" : "justify-end"}`}>
			<div
				className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
					inbound
						? "bg-muted text-foreground"
						: "bg-primary text-primary-foreground"
				}`}
			>
				<p className="whitespace-pre-wrap wrap-break-word">{message.content}</p>
				<p
					className={`mt-1 text-[11px] ${
						inbound ? "text-muted-foreground" : "text-primary-foreground/60"
					}`}
				>
					{inbound ? "Lead" : "Marko"} · {formatDateTime(message.createdAt)}
				</p>
			</div>
		</li>
	);
}

/** The full conversation history in chronological order (Req 19.3, 20.2). */
export function MessageHistoryCard({ messages }: { messages: MessageView[] }) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>Histórico de mensagens</CardTitle>
			</CardHeader>
			<CardContent>
				{messages.length === 0 ? (
					<p className="text-sm text-muted-foreground">Nenhuma mensagem ainda.</p>
				) : (
					<ul className="flex flex-col gap-2">
						{messages.map((message) => (
							<MessageBubble key={message.id} message={message} />
						))}
					</ul>
				)}
			</CardContent>
		</Card>
	);
}

/** Human-readable labels for handoff trigger reasons (Req 13.2). */
const HANDOFF_REASON_LABELS: Record<HandoffEventView["reason"], string> = {
	replied: "Lead respondeu — repassado ao consultor",
	hot_score: "Pontuação ultrapassou 70 (quente)",
	frustration: "Frustração detectada",
	out_of_data: "Solicitou informação indisponível",
};

/** The handoff events that transferred a lead to a consultant (Req 13.2, 20.4). */
export function HandoffEventsCard({ events }: { events: HandoffEventView[] }) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>Eventos de repasse</CardTitle>
			</CardHeader>
			<CardContent>
				{events.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						Nenhum evento de repasse.
					</p>
				) : (
					<ul className="flex flex-col gap-2 text-sm">
						{events.map((event) => (
							<li
								key={event.id}
								className="flex items-center justify-between gap-3 border-b border-border pb-2 last:border-none last:pb-0"
							>
								<span className="text-foreground">
									{HANDOFF_REASON_LABELS[event.reason]}
								</span>
								<span className="text-muted-foreground">
									{formatDateTime(event.createdAt)}
								</span>
							</li>
						))}
					</ul>
				)}
			</CardContent>
		</Card>
	);
}
