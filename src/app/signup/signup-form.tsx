// Signup form (client) — registers the user and provisions their tenant.
//
// Side-effect boundary: client component. Three steps through the Better Auth
// browser client: `signUp.email` creates the user and signs them in,
// `organization.create` provisions the tenant, and `organization.setActive`
// stamps it on the live session (the session-creation hook only covers future
// logins). On success the user lands in the CRM.

"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { authClient, signUp } from "@/services/auth-client";

/**
 * A URL-safe slug for the organization: the company name lowercased and
 * accent-stripped, plus a short random suffix so two companies with the same
 * name never collide.
 */
function toOrgSlug(companyName: string): string {
	const base = companyName
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	const suffix = crypto.randomUUID().slice(0, 6);
	return base ? `${base}-${suffix}` : suffix;
}

export function SignupForm() {
	const router = useRouter();

	const [companyName, setCompanyName] = useState("");
	const [name, setName] = useState("");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setPending(true);
		setError(null);

		const { error: signUpError } = await signUp.email({
			name,
			email,
			password,
		});
		if (signUpError) {
			setPending(false);
			setError(signUpError.message ?? "Falha ao criar a conta");
			return;
		}

		const { data: org, error: orgError } = await authClient.organization.create(
			{
				name: companyName,
				slug: toOrgSlug(companyName),
			},
		);
		if (orgError || !org) {
			setPending(false);
			setError(orgError?.message ?? "Falha ao criar a empresa");
			return;
		}

		await authClient.organization.setActive({ organizationId: org.id });

		router.replace("/crm");
		router.refresh();
	}

	return (
		<form onSubmit={handleSubmit} className="flex w-72 flex-col gap-3">
			<label className="flex flex-col gap-1 text-sm">
				Nome da empresa
				<input
					type="text"
					required
					value={companyName}
					onChange={(event) => setCompanyName(event.target.value)}
					className="rounded border px-2 py-1"
					autoComplete="organization"
				/>
			</label>
			<label className="flex flex-col gap-1 text-sm">
				Seu nome
				<input
					type="text"
					required
					value={name}
					onChange={(event) => setName(event.target.value)}
					className="rounded border px-2 py-1"
					autoComplete="name"
				/>
			</label>
			<label className="flex flex-col gap-1 text-sm">
				E-mail
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
				Senha
				<input
					type="password"
					required
					minLength={8}
					value={password}
					onChange={(event) => setPassword(event.target.value)}
					className="rounded border px-2 py-1"
					autoComplete="new-password"
				/>
			</label>
			{error ? <p className="text-sm text-red-600">{error}</p> : null}
			<button
				type="submit"
				disabled={pending}
				className="rounded bg-primary px-3 py-1.5 text-sm text-white disabled:opacity-50"
			>
				{pending ? "Criando conta…" : "Criar conta"}
			</button>
		</form>
	);
}
