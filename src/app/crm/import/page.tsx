// CRM_UI CSV import page (Req 20.3).
//
// Side-effect boundary: client component. An operator selects a CSV file and
// uploads it to the guarded `/api/crm/import` endpoint (which reuses the
// Lead_Importer); the returned import result report — created / updated /
// rejected counts and per-row reasons — is displayed (Req 1.6, 20.3).

"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";

import { PageHeader } from "../_components/ui";
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
				? "bg-status-info/10 text-status-info"
				: "bg-destructive/10 text-destructive";
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
		<div className="overflow-hidden rounded-lg border border-border">
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>Linha</TableHead>
						<TableHead>Resultado</TableHead>
						<TableHead>Detalhe</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{report.rows.map((row) => (
						<TableRow key={`${row.rowNumber}-${row.outcome}`}>
							<TableCell className="tabular-nums text-muted-foreground">
								{row.rowNumber}
							</TableCell>
							<TableCell>
								<span
									className={
										row.outcome === "rejected"
											? "text-destructive"
											: "text-primary"
									}
								>
									{row.outcome}
								</span>
							</TableCell>
							<TableCell className="text-muted-foreground">
								{row.reason ?? row.leadId ?? "—"}
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
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
				title="Importar leads"
				description="Envie um CSV de leads frios. Cada linha é normalizada e deduplicada; o relatório é exibido abaixo."
			/>

			<Card className="mb-6">
				<CardContent>
					<form onSubmit={handleSubmit} className="flex flex-col gap-4">
						<div className="flex flex-col gap-2">
							<Label htmlFor="csv-file">Arquivo CSV</Label>
							<Input
								id="csv-file"
								type="file"
								accept=".csv,text/csv"
								onChange={(event) => {
									setFile(event.target.files?.[0] ?? null);
									importCsv.reset();
								}}
								className="max-w-sm"
							/>
						</div>
						<div>
							<Button
								type="submit"
								disabled={!file || importCsv.isPending}
							>
								{importCsv.isPending ? "Importando…" : "Importar CSV"}
							</Button>
						</div>
					</form>
				</CardContent>
			</Card>

			{report ? (
				<Card>
					<CardHeader>
						<CardTitle>Resultado da importação</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="mb-5 grid grid-cols-3 gap-3">
							<CountTile
								label="Criados"
								value={report.createdCount}
								tone="created"
							/>
							<CountTile
								label="Atualizados"
								value={report.updatedCount}
								tone="updated"
							/>
							<CountTile
								label="Rejeitados"
								value={report.rejectedCount}
								tone="rejected"
							/>
						</div>
						{report.rows.length > 0 ? (
							<ReportRows report={report} />
						) : (
							<p className="text-sm text-muted-foreground">
								Nenhuma linha no arquivo enviado.
							</p>
						)}
					</CardContent>
				</Card>
			) : null}
		</div>
	);
}
