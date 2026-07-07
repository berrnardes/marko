"use client";

// Animated counter for the hero "extrato" numbers: counting the rent loss up
// from zero makes the size of the number land harder than a static figure.
// Jumps straight to the final value under `prefers-reduced-motion`.

import { useEffect, useRef, useState } from "react";

type CountUpProps = {
	target: number;
	prefix?: string;
	suffix?: string;
	durationMs?: number;
	className?: string;
};

export function CountUp({
	target,
	prefix = "",
	suffix = "",
	durationMs = 1600,
	className,
}: CountUpProps) {
	const ref = useRef<HTMLSpanElement>(null);
	const [value, setValue] = useState(0);

	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		let raf = 0;
		const observer = new IntersectionObserver(
			([entry]) => {
				if (!entry.isIntersecting) return;
				observer.disconnect();
				if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
					setValue(target);
					return;
				}
				const start = performance.now();
				const tick = (now: number) => {
					const t = Math.min((now - start) / durationMs, 1);
					const eased = 1 - Math.pow(1 - t, 3);
					setValue(Math.round(target * eased));
					if (t < 1) raf = requestAnimationFrame(tick);
				};
				raf = requestAnimationFrame(tick);
			},
			{ threshold: 0.5 },
		);
		observer.observe(el);
		return () => {
			observer.disconnect();
			cancelAnimationFrame(raf);
		};
	}, [target, durationMs]);

	return (
		<span ref={ref} className={`tabular-nums ${className ?? ""}`}>
			{prefix}
			{value.toLocaleString("pt-BR")}
			{suffix}
		</span>
	);
}
