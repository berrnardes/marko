// CRM_UI presentational components (task 22.3).
//
// Small, reusable visual building blocks over the shadcn/ui primitives:
// lifecycle and classification badges, the score pill, page headers, async
// state placeholders, and the destructive-confirmation button. Presentation
// only — no data fetching.

"use client";

import { useState } from "react";

import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ClassificationBand, LifecycleState } from "@/core/types";

import { LIFECYCLE_LABELS } from "../_lib/format";

/** Badge classes per lifecycle state, on the shadcn theme tokens (Req 20.1). */
const LIFECYCLE_STYLES: Record<LifecycleState, string> = {
	COLD_QUEUED: "border-border bg-transparent text-muted-foreground",
	IN_CADENCE: "border-primary/20 bg-transparent text-primary",
	REPLIED: "border-transparent bg-primary/10 text-primary",
	QUALIFYING: "border-transparent bg-secondary/10 text-secondary",
	HOT: "border-transparent bg-secondary text-secondary-foreground",
	WARM: "border-transparent bg-secondary/80 text-secondary-foreground",
	DISQUALIFIED: "border-transparent bg-muted text-muted-foreground",
	CADENCE_EXHAUSTED: "border-transparent bg-muted text-muted-foreground",
	MONTHLY_NURTURE: "border-transparent bg-primary/10 text-primary",
	OPTED_OUT: "border-transparent bg-primary text-primary-foreground",
};

/** A pill showing a lead's lifecycle state (Req 20.1). */
export function LifecycleBadge({ state }: { state: LifecycleState }) {
	return (
		<Badge variant="outline" className={LIFECYCLE_STYLES[state]}>
			{LIFECYCLE_LABELS[state]}
		</Badge>
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
			? "bg-secondary text-secondary-foreground"
			: band === "WARM"
				? "bg-secondary/80 text-secondary-foreground"
				: band === "cold"
					? "bg-primary/10 text-primary"
					: "bg-muted text-muted-foreground";
	return (
		<span
			className={`inline-flex min-w-9 items-center justify-center rounded-md px-2 py-0.5 text-sm font-semibold tabular-nums ${tint}`}
		>
			{score}
		</span>
	);
}

/** A page title block with an optional description. */
export function PageHeader({
	title,
	description,
}: {
	title: string;
	description?: string;
}) {
	return (
		<header className="mb-6">
			<h1 className="font-heading text-2xl font-semibold text-foreground">
				{title}
			</h1>
			{description ? (
				<p className="mt-1 text-sm text-muted-foreground">{description}</p>
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
	const color = tone === "error" ? "text-destructive" : "text-muted-foreground";
	return <p className={`py-8 text-center text-sm ${color}`}>{children}</p>;
}

/**
 * A button whose action only runs after the user confirms it in an
 * AlertDialog — the shadcn replacement for `window.confirm` on destructive
 * or hard-to-undo actions.
 */
export function ConfirmButton({
	children,
	title,
	description,
	confirmLabel,
	onConfirm,
	disabled,
	variant = "destructive",
	size = "sm",
}: {
	children: React.ReactNode;
	title: string;
	description: string;
	confirmLabel: string;
	onConfirm: () => void;
	disabled?: boolean;
	variant?: React.ComponentProps<typeof Button>["variant"];
	size?: React.ComponentProps<typeof Button>["size"];
}) {
	const [open, setOpen] = useState(false);
	return (
		<AlertDialog open={open} onOpenChange={setOpen}>
			<AlertDialogTrigger
				disabled={disabled}
				render={
					<Button variant={variant} size={size}>
						{children}
					</Button>
				}
			/>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>{title}</AlertDialogTitle>
					<AlertDialogDescription>{description}</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancelar</AlertDialogCancel>
					<AlertDialogAction
						variant={variant}
						onClick={() => {
							setOpen(false);
							onConfirm();
						}}
					>
						{confirmLabel}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
