"use client";

// FAQ accordion. One item open at a time keeps the reader focused on a single
// objection; the height animation (grid-rows trick) signals where the answer
// came from instead of teleporting content in.

import { useState } from "react";

export type FaqItem = { question: string; answer: string };

export function Faq({ items }: { items: FaqItem[] }) {
	const [open, setOpen] = useState<number | null>(0);

	return (
		<div className="divide-y divide-ink/10 rounded-2xl border border-ink/10 bg-surface-card">
			{items.map((item, index) => {
				const isOpen = open === index;
				return (
					<div key={item.question}>
						<button
							type="button"
							onClick={() => setOpen(isOpen ? null : index)}
							aria-expanded={isOpen}
							className="flex w-full items-center justify-between gap-4 px-6 py-5 text-left"
						>
							<span className="text-base font-semibold sm:text-lg">
								{item.question}
							</span>
							<span
								aria-hidden
								className={`grid size-8 shrink-0 place-items-center rounded-full border border-ink/15 text-lg leading-none text-primary transition-transform duration-300 motion-reduce:transition-none ${
									isOpen ? "rotate-45" : ""
								}`}
							>
								+
							</span>
						</button>
						<div
							className={`grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none ${
								isOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
							}`}
						>
							<div className="overflow-hidden">
								<p className="px-6 pb-6 text-ink/75">{item.answer}</p>
							</div>
						</div>
					</div>
				);
			})}
		</div>
	);
}
