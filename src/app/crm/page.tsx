// CRM_UI lead list (Req 20.1).
//
// Side-effect boundary: client component. Lists every lead with its lifecycle
// state (Req 20.1), fetched via React Query from the guarded `/api/crm/leads`
// endpoint. A state filter with live counts, a text search over phone/source,
// and a sortable "updated" column make the list scannable at real lead volume.
// Each row links to the lead detail view.
//
// The filter used to group ten states into temperature buckets (hot/warm/
// engaged/…). ADR-003 cut the machine to seven states that ARE the segments an
// operator acts on, so the pills now map one-to-one onto lifecycle states and
// the bucket indirection is gone.

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
	StatusNote,
	TableSkeleton,
} from "./_components/ui";
import { useLeads } from "./_lib/api";
import { formatDateTime, LIFECYCLE_LABELS } from "./_lib/format";
import type { LeadSummaryView } from "./_lib/types";

// ---------------------------------------------------------------------------
// State filter — one pill per lifecycle state (ADR-003), plus "all".
// ---------------------------------------------------------------------------

type FilterKey = LifecycleState | "all";

/**
 * The filter pills in workflow order: the lead's journey left to right, with
 * the outcomes last. `dot` mirrors the lifecycle dot colors from
 * {@link LifecycleBadge} so the pill and the row badge read as the same thing.
 */
const FILTERS: ReadonlyArray<{ key: FilterKey; dot?: string }> = [
	{ key: "all" },
	{ key: "QUEUED", dot: "border border-muted-foreground/60" },
	{ key: "IN_CADENCE", dot: "bg-primary" },
	{ key: "REPLIED", dot: "bg-status-info" },
	{ key: "COMPLETED", dot: "bg-muted-foreground/50" },
	{ key: "WON", dot: "bg-status-won" },
	{ key: "LOST", dot: "bg-status-lost" },
	{ key: "OPTED_OUT", dot: "bg-muted-foreground/50" },
];

type Counts = Record<FilterKey, number>;
type SortField = "updatedAt";
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

	const [filter, setFilter] = useState<FilterKey>("all");
	const [query, setQuery] = useState("");
	const [sort, setSort] = useState<Sort>({ field: "updatedAt", dir: "desc" });

	// Live counts per state, recomputed only when the lead set changes.
	const counts = useMemo<Counts>(() => {
		const base: Counts = {
			all: leads?.length ?? 0,
			QUEUED: 0,
			IN_CADENCE: 0,
			REPLIED: 0,
			COMPLETED: 0,
			WON: 0,
			LOST: 0,
			OPTED_OUT: 0,
		};
		for (const lead of leads ?? []) {
			base[lead.lifecycleState] += 1;
		}
		return base;
	}, [leads]);

	// The rows actually rendered: state filter → text search → sort.
	const visible = useMemo<LeadSummaryView[]>(() => {
		let rows = leads ?? [];
		if (filter !== "all") {
			rows = rows.filter((lead) => lead.lifecycleState === filter);
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
		return [...rows].sort(
			(a, b) =>
				(new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime()) * dir,
		);
	}, [leads, filter, query, sort]);

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
				description="Todos os leads com seu estado atual no ciclo de vida."
			/>

			{isPending ? <TableSkeleton columns={4} /> : null}
			{isError ? <StatusNote tone="error">{error.message}</StatusNote> : null}

			{leads && !hasLeads ? (
				<StatusNote>Nenhum lead ainda. Importe um CSV para começar.</StatusNote>
			) : null}

			{hasLeads ? (
				<>
					{/* Toolbar: state filter + search. */}
					<div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
						<div className="flex flex-wrap gap-1.5">
							{FILTERS.map((f) => (
								<FilterPill
									key={f.key}
									label={f.key === "all" ? "Todos" : LIFECYCLE_LABELS[f.key]}
									count={counts[f.key]}
									dot={f.dot}
									active={filter === f.key}
									onClick={() => setFilter(f.key)}
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
