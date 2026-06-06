// CRM_UI presentational components (task 22.3).
//
// Small, reusable visual building blocks styled with the brand tokens: lifecycle
// and classification badges, the score pill, page headers, and async state
// placeholders. Presentation only — no data fetching.

import type { ClassificationBand, LifecycleState } from "@/core/types";

import { LIFECYCLE_LABELS } from "../_lib/format";

/** Tailwind classes per lifecycle state, on the brand palette (Req 20.1). */
const LIFECYCLE_STYLES: Record<LifecycleState, string> = {
	COLD_QUEUED: "bg-surface text-ink/70 border border-ink/15",
	IN_CADENCE: "bg-surface text-primary border border-primary/20",
	REPLIED: "bg-primary/10 text-primary border border-primary/20",
	QUALIFYING: "bg-accent/15 text-secondary border border-accent/30",
	HOT: "bg-secondary text-white",
	WARM: "bg-accent text-white",
	DISQUALIFIED: "bg-ink/10 text-ink/60 border border-ink/15",
	CADENCE_EXHAUSTED: "bg-ink/10 text-ink/60 border border-ink/15",
	MONTHLY_NURTURE: "bg-primary/10 text-primary border border-primary/20",
	OPTED_OUT: "bg-ink text-white",
};

/** A pill showing a lead's lifecycle state (Req 20.1). */
export function LifecycleBadge({ state }: { state: LifecycleState }) {
	return (
		<span
			className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${LIFECYCLE_STYLES[state]}`}
		>
			{LIFECYCLE_LABELS[state]}
		</span>
	);
}

/** A pill showing a lead's score, tinted by band (Req 20.1). */
export function ScoreBadge({
	score,
	band,
}: {
	score: number;
	band: ClassificationBand | null;
}) {
	const tint =
		band === "HOT"
			? "bg-secondary text-white"
			: band === "WARM"
				? "bg-accent text-white"
				: band === "cold"
					? "bg-primary/10 text-primary"
					: "bg-ink/10 text-ink/60";
	return (
		<span
			className={`inline-flex min-w-9 items-center justify-center rounded-md px-2 py-0.5 text-sm font-semibold tabular-nums ${tint}`}
		>
			{score}
		</span>
	);
}

/** A page title block with the display font and an optional description. */
export function PageHeader({
	title,
	description,
}: {
	title: string;
	description?: string;
}) {
	return (
		<header className="mb-6">
			<h1 className="font-display text-2xl font-semibold text-primary">
				{title}
			</h1>
			{description ? (
				<p className="mt-1 text-sm text-ink/60">{description}</p>
			) : null}
		</header>
	);
}

/** A centered, muted status line for loading / empty / error states. */
export function StatusNote({
	children,
	tone = "muted",
}: {
	children: React.ReactNode;
	tone?: "muted" | "error";
}) {
	const color = tone === "error" ? "text-secondary" : "text-ink/50";
	return <p className={`py-8 text-center text-sm ${color}`}>{children}</p>;
}

/** A surface card wrapper used to group detail sections. */
export function Card({
	children,
	className = "",
}: {
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<section
			className={`rounded-lg border border-ink/10 bg-surface-card p-5 shadow-sm ${className}`}
		>
			{children}
		</section>
	);
}
