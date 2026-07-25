// Signup page — self-service registration, currently closed.
//
// Registration is disabled at the Better Auth level (`disableSignUp`, see
// `@/services/auth`) until the tenancy retrofit lands: the domain tables do
// not filter by organization yet, so a new account would read the existing
// tenant's leads. This page states that instead of rendering a form whose
// submit the API would reject.
//
// To re-open: drop `disableSignUp`, restore `<SignupForm />` (kept in
// `./signup-form`) in place of the notice below, and remove this paragraph.

import Link from "next/link";
import { redirect } from "next/navigation";

import { getServerSession } from "@/services/auth";

export default async function SignupPage() {
	const session = await getServerSession();
	if (session) {
		redirect("/crm");
	}

	return (
		<main className="app-theme flex min-h-screen flex-col items-center justify-center gap-6 bg-background text-foreground">
			<h1 className="text-xl font-semibold">Marko CRM</h1>
			<div className="max-w-sm rounded-lg border border-border p-6 text-center">
				<p className="font-medium">Cadastro temporariamente fechado</p>
				<p className="mt-2 text-sm text-muted-foreground">
					Estamos preparando a plataforma para novos clientes. Se você já tem
					uma conta, faça login normalmente.
				</p>
			</div>
			<p className="text-sm">
				Já tem uma conta?{" "}
				<Link href="/login" className="text-primary underline">
					Entrar
				</Link>
			</p>
		</main>
	);
}
