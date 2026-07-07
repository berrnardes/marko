"use client";

// Scroll-reveal wrapper: fades/slides content in once, when it enters the
// viewport, so each section is introduced in reading order. Motion is purely
// presentational — content is fully visible without JS-driven animation for
// users with `prefers-reduced-motion`.

import { useEffect, useRef, useState } from "react";

type RevealProps = {
	children: React.ReactNode;
	/** Stagger offset in ms, for sibling elements revealed together. */
	delay?: number;
	className?: string;
};

export function Reveal({ children, delay = 0, className = "" }: RevealProps) {
	const ref = useRef<HTMLDivElement>(null);
	const [visible, setVisible] = useState(false);

	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const observer = new IntersectionObserver(
			([entry]) => {
				if (entry.isIntersecting) {
					setVisible(true);
					observer.disconnect();
				}
			},
			{ threshold: 0.15, rootMargin: "0px 0px -8% 0px" },
		);
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	return (
		<div
			ref={ref}
			style={{ transitionDelay: `${delay}ms` }}
			className={`transition-all duration-700 ease-out ${
				visible ? "translate-y-0 opacity-100" : "translate-y-6 opacity-0"
			} motion-reduce:translate-y-0 motion-reduce:opacity-100 motion-reduce:transition-none ${className}`}
		>
			{children}
		</div>
	);
}
