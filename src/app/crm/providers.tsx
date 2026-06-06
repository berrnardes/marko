// CRM_UI client data-fetching provider (task 22.3).
//
// Side-effect boundary: client component. Establishes the TanStack React Query
// client used by the CRM pages to fetch and cache lead data from the internal
// `/api/crm/*` endpoints (Tech: React Query is the client data-fetching/caching
// library). A single `QueryClient` is created per browser session via state so
// it is stable across re-renders.

"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

export function CrmQueryProvider({
	children,
}: Readonly<{ children: React.ReactNode }>) {
	const [client] = useState(
		() =>
			new QueryClient({
				defaultOptions: {
					queries: {
						// Lead data changes server-side via the worker/webhook; a short
						// stale time avoids hammering while keeping the UI reasonably fresh.
						staleTime: 15_000,
						refetchOnWindowFocus: false,
						retry: 1,
					},
				},
			}),
	);

	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
