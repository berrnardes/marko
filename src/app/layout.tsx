// Root layout — wires the brand fonts and global styling (task 22.3).
//
// The main font, "Hanken Grotesque", is loaded through `next/font` and applied
// globally via the `--font-hanken` variable (mapped to Tailwind's `font-sans`
// token in `globals.css`). The secondary "Fraunces" display face is loaded
// alongside it and exposed as `--font-fraunces` (Tailwind `font-display`) for
// sparing use on headings.

import type { Metadata } from "next";
import { Hanken_Grotesk } from "next/font/google";
import "./globals.css";

const hankenGrotesque = Hanken_Grotesk({
	variable: "--font-hanken",
	subsets: ["latin"],
	display: "swap",
});

export const metadata: Metadata = {
	title: "Marko — Consultoria de aquisição de patrimônio",
	description:
		"A Marko monta seu plano para trocar o aluguel por patrimônio usando consórcio — sem juros de banco, sem entrada impossível.",
};

export default function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	return (
		<html
			lang="pt-BR"
			suppressHydrationWarning
			className={`${hankenGrotesque.variable} h-full antialiased`}
		>
			<body className="min-h-full flex flex-col font-sans">{children}</body>
		</html>
	);
}
