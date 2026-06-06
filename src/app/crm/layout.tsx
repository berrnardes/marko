// Protected CRM boundary + shell (Req 21.1, 21.3; task 22.3).
//
// Every CRM_UI page lives under this layout. It performs the authoritative,
// server-side session check via `getServerSession`: an unauthenticated or
// expired session is denied and redirected to the login page before any lead
// data is read (Req 21.1, 21.3). For authenticated operators it renders the
// navigation shell and wraps the page tree in the React Query provider that the
// client pages use to fetch from the guarded `/api/crm/*` endpoints.

import { redirect } from "next/navigation";

import { getServerSession } from "@/services/auth";

import { CrmNav } from "./_components/nav";
import { CrmQueryProvider } from "./providers";

export default async function CrmLayout({
	children,
}: Readonly<{ children: React.ReactNode }>) {
	const session = await getServerSession();
	if (!session) {
		redirect("/login?next=/crm");
	}

	return (
		<CrmQueryProvider>
			<div className="flex min-h-full flex-col">
				<CrmNav email={session.user.email ?? null} />
				<main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
					{children}
				</main>
			</div>
		</CrmQueryProvider>
	);
}
