// CRM_UI CSV import page (Req 20.3).
//
// Side-effect boundary: client component. An operator selects a CSV file and
// uploads it to the guarded `/api/crm/import` endpoint (which reuses the
// Lead_Importer); the returned import result report — created / updated /
// rejected counts and per-row reasons — is displayed (Req 1.6, 20.3).

"use client";

import { useState } from "react";

import { Card, PageHeader, StatusNote } from "../_components/ui";
import { useImportCsv } from "../_lib/api";
import type { ImportReportView } from "../_lib/types";

/** A labelled count tile in the report summary. */
function CountTile({
	label,
	value,
	tone,
}: {
	label: string;
	value: number;
	tone: "created" | "updated" | "rejected";
}) {
	const styles =
		tone === "created"
			? "bg-primary/10 text-primary"
			: tone === "updated"
				? "bg-accent/15 text-secondary"
				: "bg-secondary/10 text-secondary";
	return (
		<div className={`rounded-lg px-4 py-3 ${styles}`}>
			<div className="text-2xl font-semibold tabular-nums">{value}</div>
			<div className="text-xs uppercase tracking-wide">{label}</div>
		</div>
	);
}

/** The per-row outcomes table, surfacing rejection reasons (Req 1.3, 20.3). */
function ReportRows({ report }: { report: ImportReportView }) {
	return (
		<div className="overflow-hidden rounded-lg border border-ink/10">
			<table className="w-full text-left text-sm">
				<thead className="border-b border-ink/10 bg-surface/60 text-xs uppercase tracking-wide text-ink/50">
					<tr>
						<th className="px-4 py-2 font-medium">Row</th>
						<th className="px-4 py-2 font-medium">Outcome</th>
						<th className="px-4 py-2 font-medium">Detail</th>
					</tr>
				</thead>
				<tbody className="divide-y divide-ink/5">
					{report.rows.map((row) => (
						<tr key={`${row.rowNumber}-${row.outcome}`}>
							<td className="px-4 py-2 tabular-nums text-ink/70">
								{row.rowNumber}
							</td>
							<td className="px-4 py-2">
								<span
									className={
										row.outcome === "rejected"
											? "text-secondary"
											: "text-primary"
									}
								>
									{row.outcome}
								</span>
							</td>
							<td className="px-4 py-2 text-ink/60">
								{row.reason ?? row.leadId ?? "—"}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

export default function ImportPage() {
	const [file, setFile] = useState<File | null>(null);
	const importCsv = useImportCsv();

	function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (file) {
			importCsv.mutate(file);
		}
	}

	const report = importCsv.data;

	return (
		<div>
			<PageHeader
				title="Import leads"
				description="Upload a CSV of cold leads. Each row is normalized and deduplicated; the result report is shown below."
			/>

			<Card className="mb-6">
				<form onSubmit={handleSubmit} className="flex flex-col gap-4">
					<label className="flex flex-col gap-2 text-sm">
						<span className="font-medium text-ink">CSV file</span>
						<input
							type="file"
							accept=".csv,text/csv"
							onChange={(event) => {
								setFile(event.target.files?.[0] ?? null);
								importCsv.reset();
							}}
							className="text-sm file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-1.5 file:text-sm file:text-surface hover:file:bg-primary/90"
						/>
					</label>
					<div>
						<button
							type="submit"
							disabled={!file || importCsv.isPending}
							className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-50"
						>
							{importCsv.isPending ? "Importing…" : "Import CSV"}
						</button>
					</div>
				</form>
			</Card>

			{importCsv.isError ? (
				<StatusNote tone="error">{importCsv.error.message}</StatusNote>
			) : null}

			{report ? (
				<Card>
					<h2 className="mb-4 font-display text-lg font-semibold text-primary">
						Import result
					</h2>
					<div className="mb-5 grid grid-cols-3 gap-3">
						<CountTile
							label="Created"
							value={report.createdCount}
							tone="created"
						/>
						<CountTile
							label="Updated"
							value={report.updatedCount}
							tone="updated"
						/>
						<CountTile
							label="Rejected"
							value={report.rejectedCount}
							tone="rejected"
						/>
					</div>
					{report.rows.length > 0 ? (
						<ReportRows report={report} />
					) : (
						<p className="text-sm text-ink/50">No rows in the uploaded file.</p>
					)}
				</Card>
			) : null}
		</div>
	);
}
