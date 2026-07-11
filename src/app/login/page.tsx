// Login page (Req 21.1, 21.2).
//
// Public entry point where unauthenticated users land after the guard denies
// access. If a valid session already exists, the user is sent straight to the
// CRM rather than shown the form. The interactive form is a client component;
// it is wrapped in Suspense because it reads the `next` search param.

import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { getServerSession } from "@/services/auth";

import { LoginForm } from "./login-form";

export default async function LoginPage() {
	const session = await getServerSession();
	if (session) {
		redirect("/crm");
	}

	return (
		<main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-su">
			<h1 className="text-xl font-semibold">Marko CRM</h1>
			<Suspense fallback={null}>
				<LoginForm />
			</Suspense>
			<p className="text-sm">
				Não tem uma conta?{" "}
				<Link href="/signup" className="text-primary underline">
					Criar conta
				</Link>
			</p>
		</main>
	);
}
