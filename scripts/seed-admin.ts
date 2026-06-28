// Bootstrap the single beta admin account.
//
// Self-service registration is disabled in the app (see `disableSignUp` in
// `@/services/auth`), so accounts cannot be created through the public
// `/api/auth/sign-up/email` route. This script provisions the one beta account
// instead, using Better Auth's server-side context directly: it hashes the
// password and writes the `user` + credential `account` rows the same way the
// sign-up route would, but bypassing the disabled route guard.
//
// It is idempotent: if the account already exists it leaves it untouched, or —
// with `--reset-password` — re-hashes and stores the supplied password so the
// beta operator can recover access without touching the database by hand.
//
// Run with:
//   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=... npm run db:seed-admin
//   (add `-- --reset-password` to update an existing account's password)

import { pool } from "@/db/client";
import { auth } from "@/services/auth";

/** Minimum password length enforced before we hand anything to Better Auth. */
const MIN_PASSWORD_LENGTH = 8;

function shouldResetPassword(): boolean {
	return (
		process.argv.includes("--reset-password") ||
		process.env.ADMIN_RESET_PASSWORD === "yes"
	);
}

async function main(): Promise<void> {
	// Better Auth matches accounts by lowercased email, so store it lowercased
	// to guarantee sign-in finds this row regardless of how it was typed in.
	const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
	const password = process.env.ADMIN_PASSWORD;
	const name = process.env.ADMIN_NAME?.trim() || "Admin";

	if (!email || !password) {
		console.error(
			"Missing credentials. Provide ADMIN_EMAIL and ADMIN_PASSWORD.\n\n" +
				"Example:\n" +
				"  ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a-strong-password' \\\n" +
				"    npm run db:seed-admin",
		);
		process.exitCode = 1;
		return;
	}

	if (password.length < MIN_PASSWORD_LENGTH) {
		console.error(
			`ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters.`,
		);
		process.exitCode = 1;
		return;
	}

	// `auth.$context` resolves to Better Auth's internal context: the password
	// hasher and the low-level adapter used by its own route handlers. Going
	// through it (rather than `auth.api.signUpEmail`) is what lets us create the
	// account while public sign-up is disabled.
	const ctx = await auth.$context;
	const hash = await ctx.password.hash(password);

	const existing = await ctx.internalAdapter.findUserByEmail(email);

	if (existing) {
		if (!shouldResetPassword()) {
			console.log(
				`Admin account already exists for ${email}; leaving it unchanged.\n` +
					"Pass --reset-password to update its password.",
			);
			return;
		}

		await ctx.internalAdapter.updatePassword(existing.user.id, hash);
		console.log(`Reset password for existing admin account ${email}.`);
		return;
	}

	const createdUser = await ctx.internalAdapter.createUser({
		email,
		name,
		// No email-delivery flow exists in the beta, so the bootstrap account is
		// created already verified — it could never receive a verification mail.
		emailVerified: true,
	});

	if (!createdUser) {
		throw new Error(`Failed to create admin user for ${email}.`);
	}

	// The credential account holds the hashed password; without it the user
	// exists but cannot sign in with email/password. This mirrors what the
	// sign-up route does after creating the user.
	await ctx.internalAdapter.linkAccount({
		userId: createdUser.id,
		providerId: "credential",
		accountId: createdUser.id,
		password: hash,
	});

	console.log(`Created admin account ${email}.`);
}

main()
	.catch((error: unknown) => {
		console.error(error);
		process.exitCode = 1;
	})
	.finally(() => {
		// The shared Drizzle pool keeps the process alive; close it so the script
		// exits once the work is done.
		void pool.end();
	});
