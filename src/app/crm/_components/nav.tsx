// CRM_UI navigation shell (task 22.3).
//
// Side-effect boundary: client component. Renders the product navigation as a
// left sidebar on desktop (md+) and a compact top bar on mobile, both driven by
// the same grouped link list. Highlights the active section from the current
// pathname and exposes the signed-in operator's email plus a sign-out action
// wired to the Better Auth browser client.

"use client";

import {
	ArrowRightLeft,
	LogOut,
	MessageSquareText,
	Settings,
	Smartphone,
	Upload,
	Users,
	type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { signOut } from "@/services/auth-client";

type NavLink = { href: string; label: string; icon: LucideIcon };
type NavGroup = { heading: string | null; links: ReadonlyArray<NavLink> };

/**
 * Navigation grouped by purpose: the day-to-day lead work on top, the
 * workspace/channel configuration below. "Modelos" is the automated-message
 * template editor (formerly the ambiguously-named "Mensagens").
 */
const NAV_GROUPS: ReadonlyArray<NavGroup> = [
	{
		heading: null,
		links: [
			{ href: "/crm", label: "Leads", icon: Users },
			{ href: "/crm/handoffs", label: "Repasses", icon: ArrowRightLeft },
			{ href: "/crm/import", label: "Importar", icon: Upload },
		],
	},
	{
		heading: "Configuração",
		links: [
			{ href: "/crm/numbers", label: "Números", icon: Smartphone },
			{ href: "/crm/mensagens", label: "Modelos", icon: MessageSquareText },
			{ href: "/crm/configuracoes", label: "Configurações", icon: Settings },
		],
	},
];

const FLAT_LINKS: ReadonlyArray<NavLink> = NAV_GROUPS.flatMap(
	(group) => group.links,
);

/** Whether `href` is the active section for the current `pathname`. */
function isActive(pathname: string, href: string): boolean {
	if (href === "/crm") {
		// The lead list is active for /crm and its lead detail pages, but not for
		// the sibling sections.
		return pathname === "/crm" || pathname.startsWith("/crm/leads");
	}
	return pathname === href || pathname.startsWith(`${href}/`);
}

/** A single sidebar link with its icon, styled by active state. */
function SidebarLink({ link, active }: { link: NavLink; active: boolean }) {
	const Icon = link.icon;
	return (
		<Link
			href={link.href}
			className={`flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors ${
				active
					? "bg-muted font-medium text-foreground"
					: "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
			}`}
		>
			<Icon aria-hidden="true" className="size-4 shrink-0" />
			{link.label}
		</Link>
	);
}

/** Brand wordmark reused by both the sidebar and the mobile bar. */
function Brand() {
	return (
		<Link
			href="/crm"
			className="font-heading text-lg font-semibold text-foreground"
		>
			Marko<span className="text-primary">.</span>
		</Link>
	);
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
		<>
			{/* Desktop: fixed left sidebar. */}
			<aside className="hidden shrink-0 border-r border-border bg-card md:flex md:w-60 md:flex-col">
				<div className="flex h-full flex-col gap-6 px-4 py-5">
					<div className="px-2">
						<Brand />
					</div>
					<nav className="flex flex-1 flex-col gap-6">
						{NAV_GROUPS.map((group) => (
							<div
								key={group.heading ?? "main"}
								className="flex flex-col gap-0.5"
							>
								{group.heading ? (
									<p className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
										{group.heading}
									</p>
								) : null}
								{group.links.map((link) => (
									<SidebarLink
										key={link.href}
										link={link}
										active={isActive(pathname, link.href)}
									/>
								))}
							</div>
						))}
					</nav>
					<div className="flex flex-col gap-2 border-t border-border pt-4">
						{email ? (
							<span className="truncate px-2 text-xs text-muted-foreground">
								{email}
							</span>
						) : null}
						<Button
							variant="ghost"
							size="sm"
							onClick={handleSignOut}
							className="justify-start"
						>
							<LogOut aria-hidden="true" className="size-4" />
							Sair
						</Button>
					</div>
				</div>
			</aside>

			{/* Mobile: top bar with a horizontally scrollable link strip. */}
			<header className="border-b border-border bg-card md:hidden">
				<div className="flex items-center justify-between px-4 py-3">
					<Brand />
					<Button variant="ghost" size="sm" onClick={handleSignOut}>
						<LogOut aria-hidden="true" className="size-4" />
						Sair
					</Button>
				</div>
				<nav className="flex gap-1 overflow-x-auto px-2 pb-2 text-sm">
					{FLAT_LINKS.map((link) => {
						const active = isActive(pathname, link.href);
						return (
							<Link
								key={link.href}
								href={link.href}
								className={`whitespace-nowrap rounded-md px-3 py-1.5 transition-colors ${
									active
										? "bg-muted font-medium text-foreground"
										: "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
								}`}
							>
								{link.label}
							</Link>
						);
					})}
				</nav>
			</header>
		</>
	);
}
