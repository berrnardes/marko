// CRM_UI lead detail panels (task 22.3, Req 20.2, 20.4).
//
// Presentational building blocks shared by the lead detail page and the
// handed-off leads view: the lead identity header, the collected qualification
// fields, and the conversation history. Presentation only — the data is fetched
// by the pages and passed in.

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
import { Card, LifecycleBadge, ScoreBadge } from "./ui";

/** Identity + status header for a lead (phone, source, state, score). */
export function LeadHeader({ lead }: { lead: LeadDetailView }) {
	return (
		<div className="mb-6 flex flex-wrap items-center gap-3">
			<h1 className="font-display text-2xl font-semibold text-primary">
				{lead.phoneE164}
			</h1>
			<LifecycleBadge state={lead.lifecycleState} />
			<ScoreBadge score={lead.score} band={lead.classificationBand} />
			<span className="text-sm text-ink/50">via {lead.source}</span>
			{lead.optInStatus === "opt_out" ? (
				<span className="rounded-full bg-ink px-2.5 py-0.5 text-xs font-medium text-white">
					Opted out
				</span>
			) : null}
			{lead.blocked ? (
				<span className="rounded-full bg-secondary px-2.5 py-0.5 text-xs font-medium text-white">
					Blocked
				</span>
			) : null}
		</div>
	);
}

/** A single label/value row inside the qualification card. */
function Field({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex flex-col gap-0.5">
			<dt className="text-xs uppercase tracking-wide text-ink/45">{label}</dt>
			<dd className="text-sm text-ink">{value}</dd>
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
			<h2 className="mb-4 font-display text-lg font-semibold text-primary">
				Qualification
			</h2>
			<dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
				<Field label="Segment" value={formatText(qualification.segment)} />
				<Field
					label="Credit value"
					value={formatCurrency(qualification.creditValue)}
				/>
				<Field label="Objective" value={formatText(qualification.objective)} />
				<Field
					label="Lance reserve"
					value={formatBoolean(qualification.hasLanceReserve)}
				/>
				<Field label="Income" value={formatCurrency(qualification.income)} />
			</dl>
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
					inbound ? "bg-surface text-ink" : "bg-primary text-surface"
				}`}
			>
				<p className="whitespace-pre-wrap break-words">{message.content}</p>
				<p
					className={`mt-1 text-[11px] ${
						inbound ? "text-ink/40" : "text-surface/60"
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
			<h2 className="mb-4 font-display text-lg font-semibold text-primary">
				Message history
			</h2>
			{messages.length === 0 ? (
				<p className="text-sm text-ink/50">No messages yet.</p>
			) : (
				<ul className="flex flex-col gap-2">
					{messages.map((message) => (
						<MessageBubble key={message.id} message={message} />
					))}
				</ul>
			)}
		</Card>
	);
}

/** Human-readable labels for handoff trigger reasons (Req 13.2). */
const HANDOFF_REASON_LABELS: Record<HandoffEventView["reason"], string> = {
	hot_score: "Score crossed 70 (hot)",
	frustration: "Frustration detected",
	out_of_data: "Asked for unavailable information",
};

/** The handoff events that transferred a lead to a consultant (Req 13.2, 20.4). */
export function HandoffEventsCard({ events }: { events: HandoffEventView[] }) {
	return (
		<Card>
			<h2 className="mb-4 font-display text-lg font-semibold text-primary">
				Handoff events
			</h2>
			{events.length === 0 ? (
				<p className="text-sm text-ink/50">No handoff events.</p>
			) : (
				<ul className="flex flex-col gap-2 text-sm">
					{events.map((event) => (
						<li
							key={event.id}
							className="flex items-center justify-between gap-3 border-b border-ink/5 pb-2 last:border-none last:pb-0"
						>
							<span className="text-ink">
								{HANDOFF_REASON_LABELS[event.reason]}
							</span>
							<span className="text-ink/45">
								{formatDateTime(event.createdAt)}
							</span>
						</li>
					))}
				</ul>
			)}
		</Card>
	);
}
