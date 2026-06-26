// CRM_UI cadence/nurture message editing page.
//
// Side-effect boundary: client component. Lets an operator edit the six
// automated message templates (cadence T1–T5 + monthly nurture). Each template
// is plain text with `{placeholder}` variables; a live preview renders the
// template against a sample lead using the same pure `renderTemplate` the
// workers use, so what the operator sees matches what is sent.

"use client";

import { useRef, useState } from "react";

import { renderTemplate } from "@/core/messages";
import type { LeadView } from "@/core/types";

import { PageHeader, StatusNote } from "../_components/ui";
import { useResetTemplate, useSaveTemplate, useTemplates } from "../_lib/api";
import type { TemplatePlaceholderView, TemplateView } from "../_lib/types";

/** A fully-populated sample lead so the preview exercises every placeholder. */
const SAMPLE_LEAD: LeadView = {
	displayName: "João",
	qualification: {
		segment: "imóveis",
		creditValue: 50000,
		objective: "housing",
		hasLanceReserve: true,
		income: 8000,
	},
};

function TemplateCard({
	template,
	placeholders,
	onSave,
	onReset,
	saving,
	resetting,
}: {
	template: TemplateView;
	placeholders: TemplatePlaceholderView[];
	onSave: (body: string) => void;
	onReset: () => void;
	saving: boolean;
	resetting: boolean;
}) {
	const [body, setBody] = useState(template.body);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	const dirty = body !== template.body;
	const empty = body.trim().length === 0;

	function insertToken(token: string) {
		const el = textareaRef.current;
		if (!el) {
			setBody((prev) => prev + token);
			return;
		}
		const start = el.selectionStart;
		const end = el.selectionEnd;
		const next = body.slice(0, start) + token + body.slice(end);
		setBody(next);
		// Restore focus and place the cursor after the inserted token.
		requestAnimationFrame(() => {
			el.focus();
			const pos = start + token.length;
			el.setSelectionRange(pos, pos);
		});
	}

	let preview = "";
	try {
		preview = renderTemplate(body, SAMPLE_LEAD);
	} catch {
		preview = "";
	}

	return (
		<section className="rounded-lg border border-ink/10 bg-surface-card p-5 shadow-sm">
			<div className="mb-3 flex items-start justify-between gap-3">
				<div>
					<h2 className="font-display text-lg font-semibold text-primary">
						{template.label}
					</h2>
					<p className="mt-0.5 text-sm text-ink/60">{template.description}</p>
				</div>
				{template.isCustomized ? (
					<span className="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-secondary">
						Personalizado
					</span>
				) : (
					<span className="shrink-0 rounded-full bg-ink/5 px-2 py-0.5 text-xs font-medium text-ink/50">
						Padrão
					</span>
				)}
			</div>

			{/* Variable legend (clickable chips insert at the cursor). */}
			<div className="mb-2 flex flex-wrap gap-1.5">
				{placeholders.map((p) => (
					<button
						key={p.token}
						type="button"
						title={p.description}
						onClick={() => insertToken(p.token)}
						className="rounded-md border border-primary/20 bg-primary/5 px-2 py-0.5 font-mono text-xs text-primary transition-colors hover:bg-primary/10"
					>
						{p.token}
					</button>
				))}
			</div>

			<textarea
				ref={textareaRef}
				value={body}
				onChange={(e) => setBody(e.target.value)}
				rows={4}
				className="w-full resize-y rounded-md border border-ink/20 bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
			/>

			{/* Live preview against the sample lead. */}
			<div className="mt-3">
				<p className="mb-1 text-xs font-medium text-ink/50">
					Prévia (lead de exemplo)
				</p>
				<p className="rounded-md bg-surface px-3 py-2 text-sm text-ink/80">
					{preview || (
						<span className="text-ink/40">Mensagem vazia.</span>
					)}
				</p>
			</div>

			<div className="mt-3 flex items-center gap-2">
				<button
					type="button"
					disabled={!dirty || empty || saving}
					onClick={() => onSave(body)}
					className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-primary/90 disabled:opacity-50"
				>
					{saving ? "Salvando…" : "Salvar"}
				</button>
				{dirty ? (
					<button
						type="button"
						onClick={() => setBody(template.body)}
						className="rounded-md border border-ink/20 px-3 py-1.5 text-sm transition-colors hover:bg-ink/5"
					>
						Cancelar
					</button>
				) : null}
				{template.isCustomized ? (
					<button
						type="button"
						disabled={resetting}
						onClick={() => {
							if (
								confirm(
									`Restaurar a mensagem "${template.label}" para o texto padrão?`,
								)
							) {
								onReset();
							}
						}}
						className="ml-auto rounded-md border border-secondary/30 px-3 py-1.5 text-sm text-secondary transition-colors hover:bg-secondary/10 disabled:opacity-50"
					>
						Restaurar padrão
					</button>
				) : null}
			</div>
		</section>
	);
}

export default function MensagensPage() {
	const { data, isPending, isError, error } = useTemplates();
	const saveTemplate = useSaveTemplate();
	const resetTemplate = useResetTemplate();
	const [actionError, setActionError] = useState<string | null>(null);

	return (
		<div>
			<PageHeader
				title="Mensagens"
				description="Edite as mensagens automáticas de cadência (T1–T5) e o nurture mensal. Use as variáveis para personalizar com os dados do lead."
			/>

			{actionError ? (
				<StatusNote tone="error">{actionError}</StatusNote>
			) : null}

			{isPending ? <StatusNote>Carregando mensagens…</StatusNote> : null}
			{isError ? <StatusNote tone="error">{error.message}</StatusNote> : null}

			{data ? (
				<div className="flex flex-col gap-4">
					{data.templates.map((template) => (
						<TemplateCard
							// Include the server body in the key so the card remounts with
							// fresh local state after a save/reset changes the stored value.
							key={`${template.key}:${template.body}`}
							template={template}
							placeholders={data.placeholders}
							saving={saveTemplate.isPending}
							resetting={resetTemplate.isPending}
							onSave={(body) => {
								setActionError(null);
								saveTemplate.mutate(
									{ key: template.key, body },
									{ onError: (err) => setActionError(err.message) },
								);
							}}
							onReset={() => {
								setActionError(null);
								resetTemplate.mutate(template.key, {
									onError: (err) => setActionError(err.message),
								});
							}}
						/>
					))}
				</div>
			) : null}
		</div>
	);
}
