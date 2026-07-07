"use client";

// Fixed landing header. Starts transparent over the dark hero and gains an
// off-white backdrop once the user scrolls past it, keeping the wordmark and
// the simulation CTA reachable through the whole page.

import { useEffect, useState } from "react";

const NAV_LINKS = [
	{ href: "#como-funciona", label: "Como funciona" },
	{ href: "#comparativo", label: "Comparativo" },
	{ href: "#metodo", label: "Método" },
	{ href: "#faq", label: "FAQ" },
];

export function LandingHeader() {
	const [scrolled, setScrolled] = useState(false);

	useEffect(() => {
		const onScroll = () => setScrolled(window.scrollY > 32);
		onScroll();
		window.addEventListener("scroll", onScroll, { passive: true });
		return () => window.removeEventListener("scroll", onScroll);
	}, []);

	return (
		<header
			className={`fixed inset-x-0 top-0 z-50 transition-colors duration-300 ${
				scrolled
					? "border-b border-ink/10 bg-surface/90 text-ink shadow-sm backdrop-blur-md"
					: "bg-transparent text-surface"
			}`}
		>
			<div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-8">
				<a href="#" className="font-display text-2xl font-semibold tracking-tight">
					Marko<span className="text-accent">.</span>
				</a>
				<nav className="hidden items-center gap-7 text-sm font-medium md:flex">
					{NAV_LINKS.map((link) => (
						<a
							key={link.href}
							href={link.href}
							className="opacity-80 transition-opacity hover:opacity-100"
						>
							{link.label}
						</a>
					))}
				</nav>
				<a
					href="#simulacao"
					className="rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white shadow-sm transition-transform duration-200 hover:-translate-y-0.5 hover:shadow-md motion-reduce:transform-none"
				>
					Simulação gratuita
				</a>
			</div>
		</header>
	);
}
