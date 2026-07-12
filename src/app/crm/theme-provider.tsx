// CRM_UI theme provider.
//
// Side-effect boundary: client component. Keeps the CRM visual mode scoped to
// /crm, persists the browser preference locally, and exposes a small hook for
// the settings page control.

"use client";

import {
	createContext,
	useContext,
	useMemo,
	useSyncExternalStore,
} from "react";

const CRM_THEME_STORAGE_KEY = "marko.crm.theme";

type CrmTheme = "light" | "dark";

type CrmThemeContextValue = {
	theme: CrmTheme;
	isDark: boolean;
	setTheme: (theme: CrmTheme) => void;
	toggleTheme: () => void;
};

const CrmThemeContext = createContext<CrmThemeContextValue | null>(null);

const themeListeners = new Set<() => void>();

function readStoredTheme(): CrmTheme {
	if (typeof window === "undefined") {
		return "light";
	}

	return window.localStorage.getItem(CRM_THEME_STORAGE_KEY) === "dark"
		? "dark"
		: "light";
}

function subscribeToTheme(listener: () => void) {
	themeListeners.add(listener);

	function handleStorage(event: StorageEvent) {
		if (event.key === CRM_THEME_STORAGE_KEY) {
			listener();
		}
	}

	window.addEventListener("storage", handleStorage);

	return () => {
		themeListeners.delete(listener);
		window.removeEventListener("storage", handleStorage);
	};
}

function getServerThemeSnapshot(): CrmTheme {
	return "light";
}

export function CrmThemeProvider({
	children,
}: Readonly<{ children: React.ReactNode }>) {
	const theme = useSyncExternalStore(
		subscribeToTheme,
		readStoredTheme,
		getServerThemeSnapshot,
	);

	function setTheme(nextTheme: CrmTheme) {
		window.localStorage.setItem(CRM_THEME_STORAGE_KEY, nextTheme);
		themeListeners.forEach((listener) => listener());
	}

	const value = useMemo<CrmThemeContextValue>(
		() => ({
			theme,
			isDark: theme === "dark",
			setTheme,
			toggleTheme: () => setTheme(theme === "dark" ? "light" : "dark"),
		}),
		[theme],
	);

	return (
		<div
			className={`crm-theme min-h-screen bg-background text-foreground transition-colors ${
				theme === "dark" ? "dark" : ""
			}`}
		>
			<CrmThemeContext.Provider value={value}>
				{children}
			</CrmThemeContext.Provider>
		</div>
	);
}

export function useCrmTheme() {
	const context = useContext(CrmThemeContext);
	if (!context) {
		throw new Error("useCrmTheme must be used within CrmThemeProvider");
	}

	return context;
}
