// Login form (client) — minimal email/password sign-in (Req 21.2).
//
// Side-effect boundary: client component. Submits credentials through the
// Better Auth browser client; on success Better Auth sets the session cookie
// and the user is sent to the originally requested path (`next`) or the CRM
// home. A fuller CRM_UI is built in task 22.3 — this is the minimal surface
// required for route protection to function end to end.

"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { signIn } from "@/services/auth-client";

export function LoginForm() {
	const router = useRouter();
	const searchParams = useSearchParams();
	const next = searchParams.get("next") ?? "/crm";

	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setPending(true);
		setError(null);

		const { error: signInError } = await signIn.email({ email, password });
		setPending(false);

		if (signInError) {
			setError(signInError.message ?? "Sign-in failed");
			return;
		}

		router.replace(next);
		router.refresh();
	}

	return (
		<form onSubmit={handleSubmit} className="flex w-72 flex-col gap-3">
			<label className="flex flex-col gap-1 text-sm">
				Email
				<input
					type="email"
					required
					value={email}
					onChange={(event) => setEmail(event.target.value)}
					className="rounded border px-2 py-1"
					autoComplete="email"
				/>
			</label>
			<label className="flex flex-col gap-1 text-sm">
				Password
				<input
					type="password"
					required
					value={password}
					onChange={(event) => setPassword(event.target.value)}
					className="rounded border px-2 py-1"
					autoComplete="current-password"
				/>
			</label>
			{error ? <p className="text-sm text-red-600">{error}</p> : null}
			<button
				type="submit"
				disabled={pending}
				className="rounded bg-black px-3 py-1.5 text-sm text-white disabled:opacity-50"
			>
				{pending ? "Signing in…" : "Sign in"}
			</button>
		</form>
	);
}
