// Better Auth browser client (Req 21.2).
//
// Side-effect boundary: client-side only. Exposes the typed Better Auth client
// used by the login UI to start a session (`signIn.email`), by the signup UI to
// register and provision the tenant (`signUp.email` + `organization.create`),
// and to sign out. The base URL defaults to same-origin;
// `NEXT_PUBLIC_BETTER_AUTH_URL` overrides it when the app is served from a
// different origin than the API.

"use client";

import { organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
	baseURL: process.env.NEXT_PUBLIC_BETTER_AUTH_URL,
	plugins: [organizationClient()],
});

export const { signIn, signUp, signOut, useSession } = authClient;
