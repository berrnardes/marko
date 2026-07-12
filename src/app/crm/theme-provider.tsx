// CRM_UI theme shell.
//
// Side-effect boundary: client component. Scopes light/dark theming to the
// product surface with next-themes — which persists the choice and applies the
// `.dark` class to <html> before hydration, so dark-mode operators never see a
// flash of light — renders the `.app-theme` token wrapper, and mounts the toast
// host. Mounting the provider only here (not at the root) keeps the public
// landing page unthemed: it never receives `.dark`, so it stays light.

"use client";

import { ThemeProvider, useTheme } from "next-themes";

import { Toaster } from "@/components/ui/sonner";

/** Storage key kept from the previous provider so saved preferences carry over. */
const CRM_THEME_STORAGE_KEY = "marko.crm.theme";

export function CrmThemeProvider({
	children,
}: Readonly<{ children: React.ReactNode }>) {
	return (
		<ThemeProvider
			attribute="class"
			defaultTheme="light"
			enableSystem={false}
			disableTransitionOnChange
			storageKey={CRM_THEME_STORAGE_KEY}
		>
			<div className="app-theme min-h-screen bg-background text-foreground">
				{children}
			</div>
			<CrmToaster />
		</ThemeProvider>
	);
}

/** Toast host, themed to follow the current CRM light/dark mode. */
function CrmToaster() {
	const { resolvedTheme } = useTheme();
	return (
		<Toaster
			theme={resolvedTheme === "dark" ? "dark" : "light"}
			position="top-right"
			closeButton
		/>
	);
}

/**
 * Light/dark control for the settings page. Delegates to next-themes so the
 * toggle stays in sync with the persisted, flash-free theme applied to <html>.
 */
export function useCrmTheme() {
	const { resolvedTheme, setTheme } = useTheme();
	const isDark = resolvedTheme === "dark";
	return {
		isDark,
		toggleTheme: () => setTheme(isDark ? "light" : "dark"),
	};
}
