// CRM_UI top navigation (task 22.3).
//
// Side-effect boundary: client component. Renders the brand header, the section
// links (lead list, import, handoffs), the signed-in operator's email, and a
// sign-out action wired to the Better Auth browser client. Highlights the
// active section from the current pathname.

"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

import { signOut } from "@/services/auth-client";

const LINKS: ReadonlyArray<{ href: string; label: string }> = [
	{ href: "/crm", label: "Leads" },
	{ href: "/crm/import", label: "Importar" },
	{ href: "/crm/handoffs", label: "Repasses" },
];

/** Whether `href` is the active section for the current `pathname`. */
function isActive(pathname: string, href: string): boolean {
	if (href === "/crm") {
		// The lead list is active for /crm and its lead detail pages, but not for
		// the sibling sections.
		return pathname === "/crm" || pathname.startsWith("/crm/leads");
	}
	return pathname === href || pathname.startsWith(`${href}/`);
}

export function CrmNav({ email }: { email: string | null }) {
	const pathname = usePathname();
	const router = useRouter();

	async function handleSignOut() {
		await signOut();
		router.replace("/login");
		router.refresh();
	}

	return (
		<header className="border-b border-ink/10 bg-primary text-surface">
			<div className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-3">
				<Link href="/crm" className="font-display text-lg font-semibold">
					Marko
				</Link>
				<nav className="flex items-center gap-1 text-sm">
					{LINKS.map((link) => (
						<Link
							key={link.href}
							href={link.href}
							className={`rounded-md px-3 py-1.5 transition-colors ${
								isActive(pathname, link.href)
									? "bg-surface/15 font-medium text-white"
									: "text-surface/75 hover:bg-surface/10 hover:text-white"
							}`}
						>
							{link.label}
						</Link>
					))}
				</nav>
				<div className="ml-auto flex items-center gap-3 text-sm">
					{email ? <span className="text-surface/70">{email}</span> : null}
					<button
						type="button"
						onClick={handleSignOut}
						className="rounded-md border border-surface/30 px-3 py-1.5 text-surface/90 transition-colors hover:bg-surface/10 hover:text-white"
					>
						Sair
					</button>
				</div>
			</div>
		</header>
	);
}
