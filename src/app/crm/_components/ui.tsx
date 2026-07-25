// CRM_UI presentational components (task 22.3).
//
// Small, reusable visual building blocks over the shadcn/ui primitives: the
// lifecycle badge, page headers, async state placeholders, and the
// destructive-confirmation button. Presentation only — no data fetching.

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
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { LifecycleState } from "@/core/types";

import { LIFECYCLE_LABELS } from "../_lib/format";

/**
 * Dot + label tone per lifecycle state (ADR-003, Req 20.1).
 *
 * Color is spent only where it changes what someone does. `REPLIED` is the one
 * state waiting on a human, so it is the only blue; `WON`/`LOST` carry the
 * recorded outcome. Everything the system is handling by itself — queued, in
 * cadence, completed — reads as brand primary or quiet gray, with a hollow dot
 * for "not started yet" and a filled one for "finished".
 */
const LIFECYCLE_STYLES: Record<LifecycleState, { dot: string; text: string }> =
	{
		QUEUED: {
			dot: "border border-muted-foreground/60 bg-transparent",
			text: "text-muted-foreground",
		},
		IN_CADENCE: { dot: "bg-primary", text: "text-foreground" },
		REPLIED: { dot: "bg-status-info", text: "text-status-info" },
		COMPLETED: {
			dot: "bg-muted-foreground/50",
			text: "text-muted-foreground",
		},
		WON: { dot: "bg-status-won", text: "text-status-won" },
		LOST: { dot: "bg-status-lost", text: "text-status-lost" },
		OPTED_OUT: {
			dot: "bg-muted-foreground/50",
			text: "text-muted-foreground",
		},
	};

/** A colored status dot + label for a lead's lifecycle state (Req 20.1). */
export function LifecycleBadge({ state }: { state: LifecycleState }) {
	const style = LIFECYCLE_STYLES[state];
	return (
		<span
			className={`inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium ${style.text}`}
		>
			<span
				aria-hidden="true"
				className={`size-1.5 shrink-0 rounded-full ${style.dot}`}
			/>
			{LIFECYCLE_LABELS[state]}
		</span>
	);
}

/**
 * A page title block with an optional description and an optional primary
 * action (rendered top-right), so every page composes its main action the same
 * way instead of floating it loosely above the content.
 */
export function PageHeader({
	title,
	description,
	action,
}: {
	title: string;
	description?: string;
	action?: React.ReactNode;
}) {
	return (
		<header className="mb-6 flex flex-wrap items-start justify-between gap-3">
			<div>
				<h1 className="font-heading text-2xl font-semibold text-foreground">
					{title}
				</h1>
				{description ? (
					<p className="mt-1 max-w-2xl text-sm text-muted-foreground">
						{description}
					</p>
				) : null}
			</div>
			{action ? <div className="shrink-0">{action}</div> : null}
		</header>
	);
}

/** A placeholder that mirrors the list table's shape while data loads. */
export function TableSkeleton({
	rows = 5,
	columns = 5,
}: {
	rows?: number;
	columns?: number;
}) {
	return (
		<div className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
			<div className="divide-y divide-border">
				{Array.from({ length: rows }).map((_, rowIndex) => (
					<div key={rowIndex} className="flex items-center gap-4 px-4 py-3.5">
						{Array.from({ length: columns }).map((_, columnIndex) => (
							<Skeleton key={columnIndex} className="h-4 flex-1" />
						))}
					</div>
				))}
			</div>
		</div>
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
