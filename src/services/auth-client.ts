// Better Auth browser client (Req 21.2).
//
// Side-effect boundary: client-side only. Exposes the typed Better Auth client
// used by the login UI to start a session (`signIn.email`) and to sign out.
// The base URL defaults to same-origin; `NEXT_PUBLIC_BETTER_AUTH_URL` overrides
// it when the app is served from a different origin than the API.

"use client";

import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
	baseURL: process.env.NEXT_PUBLIC_BETTER_AUTH_URL,
});

export const { signIn, signOut, useSession } = authClient;
