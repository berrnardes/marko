// CRM_UI cadence/nurture message editing page.
//
// Side-effect boundary: client component. Lets an operator edit the six
// automated message templates (cadence T1–T5 + monthly nurture). Each template
// is plain text with `{placeholder}` variables; a live preview renders the
// template against a sample lead using the same pure `renderTemplate` the
// workers use, so what the operator sees matches what is sent.

"use client";

import { useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { renderTemplate } from "@/core/messages";
import type { LeadView } from "@/core/types";

import { ConfirmButton, PageHeader, StatusNote } from "../_components/ui";
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
		<Card>
			<CardHeader>
				<CardTitle>{template.label}</CardTitle>
				<CardDescription>{template.description}</CardDescription>
				<CardAction>
					{template.isCustomized ? (
						<Badge className="border-transparent bg-primary/10 text-primary">
							Personalizado
						</Badge>
					) : (
						<Badge variant="outline" className="text-muted-foreground">
							Padrão
						</Badge>
					)}
				</CardAction>
			</CardHeader>
			<CardContent className="flex flex-col gap-3">
				{/* Variable legend (clickable chips insert at the cursor). */}
				<div className="flex flex-wrap gap-1.5">
					{placeholders.map((p) => (
						<Button
							key={p.token}
							variant="outline"
							size="xs"
							title={p.description}
							onClick={() => insertToken(p.token)}
							className="font-mono text-primary"
						>
							{p.token}
						</Button>
					))}
				</div>

				<Textarea
					ref={textareaRef}
					value={body}
					onChange={(e) => setBody(e.target.value)}
					rows={4}
					className="resize-y"
				/>

				{/* Live preview against the sample lead. */}
				<div>
					<p className="mb-1 text-xs font-medium text-muted-foreground">
						Prévia (lead de exemplo)
					</p>
					<p className="rounded-md bg-muted px-3 py-2 text-sm text-foreground/80">
						{preview || (
							<span className="text-muted-foreground">Mensagem vazia.</span>
						)}
					</p>
				</div>
			</CardContent>
			<CardFooter className="gap-2">
				<Button disabled={!dirty || empty || saving} onClick={() => onSave(body)}>
					{saving ? "Salvando…" : "Salvar"}
				</Button>
				{dirty ? (
					<Button variant="ghost" onClick={() => setBody(template.body)}>
						Cancelar
					</Button>
				) : null}
				{template.isCustomized ? (
					<div className="ml-auto">
						<ConfirmButton
							variant="outline"
							size="default"
							title="Restaurar padrão"
							description={`Restaurar a mensagem "${template.label}" para o texto padrão? O texto personalizado será perdido.`}
							confirmLabel="Restaurar"
							onConfirm={onReset}
							disabled={resetting}
						>
							Restaurar padrão
						</ConfirmButton>
					</div>
				) : null}
			</CardFooter>
		</Card>
	);
}

/** Short tab label: the touch code for T1–T5, "Nurture" for the monthly touch. */
function tabLabel(key: string): string {
	return key === "nurture" ? "Nurture" : key.toUpperCase();
}

export default function MensagensPage() {
	const { data, isPending, isError, error } = useTemplates();
	const saveTemplate = useSaveTemplate();
	const resetTemplate = useResetTemplate();

	return (
		<div>
			<PageHeader
				title="Modelos de mensagem"
				description="Edite as mensagens automáticas de cadência (T1–T5) e o nurture mensal. Use as variáveis para personalizar com os dados do lead."
			/>

			{isPending ? (
				<div className="flex flex-col gap-4">
					<Skeleton className="h-8 w-80" />
					<Skeleton className="h-64 w-full rounded-xl" />
				</div>
			) : null}
			{isError ? <StatusNote tone="error">{error.message}</StatusNote> : null}

			{data ? (
				<Tabs defaultValue={data.templates[0]?.key}>
					<TabsList
						variant="line"
						className="w-full justify-start overflow-x-auto"
					>
						{data.templates.map((template) => (
							<TabsTrigger key={template.key} value={template.key}>
								{tabLabel(template.key)}
							</TabsTrigger>
						))}
					</TabsList>
					{data.templates.map((template) => (
						<TabsContent key={template.key} value={template.key}>
							<TemplateCard
								// Include the server body in the key so the card remounts with
								// fresh local state after a save/reset changes the stored value.
								key={`${template.key}:${template.body}`}
								template={template}
								placeholders={data.placeholders}
								saving={saveTemplate.isPending}
								resetting={resetTemplate.isPending}
								onSave={(body) =>
									saveTemplate.mutate({ key: template.key, body })
								}
								onReset={() => resetTemplate.mutate(template.key)}
							/>
						</TabsContent>
					))}
				</Tabs>
			) : null}
		</div>
	);
}
