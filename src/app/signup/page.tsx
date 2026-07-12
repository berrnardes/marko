// Signup page — public self-service registration for a new tenant.
//
// Public entry point where a new customer creates their account and their
// organization (workspace) in one flow. If a valid session already exists,
// the user is sent straight to the CRM rather than shown the form.

import Link from "next/link";
import { redirect } from "next/navigation";

import { getServerSession } from "@/services/auth";

import { SignupForm } from "./signup-form";

export default async function SignupPage() {
	const session = await getServerSession();
	if (session) {
		redirect("/crm");
	}

	return (
		<main className="app-theme flex min-h-screen flex-col items-center justify-center gap-6 bg-background text-foreground">
			<h1 className="text-xl font-semibold">Marko CRM</h1>
			<SignupForm />
			<p className="text-sm">
				Já tem uma conta?{" "}
				<Link href="/login" className="text-primary underline">
					Entrar
				</Link>
			</p>
		</main>
	);
}
