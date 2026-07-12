// CRM_UI lead list (Req 20.1).
//
// Side-effect boundary: client component. Lists every lead with its lifecycle
// state and score (Req 20.1), fetched via React Query from the guarded
// `/api/crm/leads` endpoint. A temperature filter (with live counts), a text
// search over phone/source, and sortable score/updated columns make the list
// scannable at real lead volume. Each row links to the lead detail view.

"use client";

import { ArrowDown, ArrowUp, ArrowUpDown, Search } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import { Input } from "@/components/ui/input";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import type { LifecycleState } from "@/core/types";

import {
	LifecycleBadge,
	PageHeader,
	ScoreBadge,
	StatusNote,
	TableSkeleton,
} from "./_components/ui";
import { useLeads } from "./_lib/api";
import { formatDateTime } from "./_lib/format";
import type { LeadSummaryView } from "./_lib/types";

// ---------------------------------------------------------------------------
// Temperature buckets — group the ten lifecycle states into the handful of
// actionable segments an operator filters by, reusing the status color ramp.
// ---------------------------------------------------------------------------

type BucketKey =
	| "all"
	| "hot"
	| "warm"
	| "engaged"
	| "cadence"
	| "nurture"
	| "cold"
	| "closed";

/** Which bucket each lifecycle state belongs to. */
const STATE_BUCKET: Record<LifecycleState, Exclude<BucketKey, "all">> = {
	HOT: "hot",
	WARM: "warm",
	REPLIED: "engaged",
	QUALIFYING: "engaged",
	IN_CADENCE: "cadence",
	MONTHLY_NURTURE: "nurture",
	COLD_QUEUED: "cold",
	DISQUALIFIED: "closed",
	CADENCE_EXHAUSTED: "closed",
	OPTED_OUT: "closed",
};

/** The filter pills, in display order. `dot` mirrors the lifecycle dot colors. */
const BUCKETS: ReadonlyArray<{ key: BucketKey; label: string; dot?: string }> = [
	{ key: "all", label: "Todos" },
	{ key: "hot", label: "Quentes", dot: "bg-status-hot" },
	{ key: "warm", label: "Mornos", dot: "bg-status-warm" },
	{ key: "engaged", label: "Engajados", dot: "bg-status-info" },
	{ key: "cadence", label: "Em cadência", dot: "bg-primary" },
	{ key: "nurture", label: "Nutrição", dot: "bg-status-nurture" },
	{ key: "cold", label: "Frios", dot: "bg-muted-foreground/50" },
	{ key: "closed", label: "Encerrados", dot: "bg-muted-foreground/50" },
];

type Counts = Record<BucketKey, number>;
type SortField = "score" | "updatedAt";
type Sort = { field: SortField; dir: "asc" | "desc" };

/** A filter pill showing its lead count, doubling as a summary tile. */
function FilterPill({
	label,
	count,
	dot,
	active,
	onClick,
}: {
	label: string;
	count: number;
	dot?: string;
	active: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-pressed={active}
			className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition-colors ${
				active
					? "border-transparent bg-foreground text-background"
					: "border-border text-muted-foreground hover:bg-muted hover:text-foreground"
			}`}
		>
			{dot ? (
				<span aria-hidden="true" className={`size-1.5 rounded-full ${dot}`} />
			) : null}
			{label}
			<span
				className={`tabular-nums ${
					active ? "text-background/70" : "text-muted-foreground/70"
				}`}
			>
				{count}
			</span>
		</button>
	);
}

/** A sortable column header; shows the direction arrow when it is the sort key. */
function SortHeader({
	label,
	field,
	sort,
	onSort,
	className,
}: {
	label: string;
	field: SortField;
	sort: Sort;
	onSort: (field: SortField) => void;
	className?: string;
}) {
	const active = sort.field === field;
	const Icon = !active ? ArrowUpDown : sort.dir === "asc" ? ArrowUp : ArrowDown;
	return (
		<TableHead className={className}>
			<button
				type="button"
				onClick={() => onSort(field)}
				className={`-mx-1 inline-flex items-center gap-1 rounded px-1 transition-colors hover:text-foreground ${
					active ? "text-foreground" : ""
				}`}
			>
				{label}
				<Icon
					aria-hidden="true"
					className={`size-3.5 ${active ? "" : "opacity-40"}`}
				/>
			</button>
		</TableHead>
	);
}

export default function LeadListPage() {
	const { data: leads, isPending, isError, error } = useLeads();

	const [bucket, setBucket] = useState<BucketKey>("all");
	const [query, setQuery] = useState("");
	const [sort, setSort] = useState<Sort>({ field: "updatedAt", dir: "desc" });

	// Live counts per bucket, recomputed only when the lead set changes.
	const counts = useMemo<Counts>(() => {
		const base: Counts = {
			all: leads?.length ?? 0,
			hot: 0,
			warm: 0,
			engaged: 0,
			cadence: 0,
			nurture: 0,
			cold: 0,
			closed: 0,
		};
		for (const lead of leads ?? []) {
			base[STATE_BUCKET[lead.lifecycleState]] += 1;
		}
		return base;
	}, [leads]);

	// The rows actually rendered: bucket filter → text search → sort.
	const visible = useMemo<LeadSummaryView[]>(() => {
		let rows = leads ?? [];
		if (bucket !== "all") {
			rows = rows.filter((lead) => STATE_BUCKET[lead.lifecycleState] === bucket);
		}
		const q = query.trim().toLowerCase();
		if (q) {
			rows = rows.filter(
				(lead) =>
					lead.phoneE164.toLowerCase().includes(q) ||
					lead.source.toLowerCase().includes(q),
			);
		}
		const dir = sort.dir === "asc" ? 1 : -1;
		return [...rows].sort((a, b) => {
			if (sort.field === "score") {
				return (a.score - b.score) * dir;
			}
			return (
				(new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime()) * dir
			);
		});
	}, [leads, bucket, query, sort]);

	// Toggle direction when re-clicking the active column; otherwise switch
	// columns and start from the most useful direction (highest / newest first).
	function handleSort(field: SortField) {
		setSort((prev) =>
			prev.field === field
				? { field, dir: prev.dir === "asc" ? "desc" : "asc" }
				: { field, dir: "desc" },
		);
	}

	const hasLeads = (leads?.length ?? 0) > 0;

	return (
		<div>
			<PageHeader
				title="Leads"
				description="Todos os leads com seu estado de ciclo de vida e pontuação atuais."
			/>

			{isPending ? <TableSkeleton columns={5} /> : null}
			{isError ? <StatusNote tone="error">{error.message}</StatusNote> : null}

			{leads && !hasLeads ? (
				<StatusNote>Nenhum lead ainda. Importe um CSV para começar.</StatusNote>
			) : null}

			{hasLeads ? (
				<>
					{/* Toolbar: temperature filter + search. */}
					<div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
						<div className="flex flex-wrap gap-1.5">
							{BUCKETS.map((b) => (
								<FilterPill
									key={b.key}
									label={b.label}
									count={counts[b.key]}
									dot={b.dot}
									active={bucket === b.key}
									onClick={() => setBucket(b.key)}
								/>
							))}
						</div>
						<div className="relative sm:w-64">
							<Search
								aria-hidden="true"
								className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
							/>
							<Input
								type="search"
								value={query}
								onChange={(event) => setQuery(event.target.value)}
								placeholder="Buscar telefone ou origem…"
								className="pl-9"
							/>
						</div>
					</div>

					<div className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Telefone</TableHead>
									<TableHead>Origem</TableHead>
									<TableHead>Estado</TableHead>
									<SortHeader
										label="Pontuação"
										field="score"
										sort={sort}
										onSort={handleSort}
									/>
									<SortHeader
										label="Atualizado"
										field="updatedAt"
										sort={sort}
										onSort={handleSort}
									/>
								</TableRow>
							</TableHeader>
							<TableBody>
								{visible.map((lead) => (
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

						{visible.length === 0 ? (
							<StatusNote>Nenhum lead corresponde aos filtros.</StatusNote>
						) : null}
					</div>

					<p className="mt-3 text-xs text-muted-foreground">
						{visible.length === counts.all
							? `${counts.all} leads`
							: `${visible.length} de ${counts.all} leads`}
					</p>
				</>
			) : null}
		</div>
	);
}
