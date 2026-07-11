// Edge session guard for CRM_UI pages and internal data endpoints (Req 21).
//
// Side-effect boundary: runs in the Next.js Proxy (edge) runtime, so it
// performs NO database access. It makes a fast, optimistic check for the
// presence of a Better Auth session cookie and redirects/denies requests that
// carry none before they ever reach a page or data endpoint that reads Lead
// data (Req 21.1, 21.3). Authoritative validation — including expiry — is done
// server-side by `getServerSession` in the protected layout and endpoints,
// where the database is available.
//
// This uses the Next.js 16 `proxy` file convention (the successor to the
// deprecated `middleware` convention); the guarded function is named `proxy`.
//
// The matcher below lists the PROTECTED surfaces (the CRM pages and the
// internal CRM API); everything else — landing page, blog, login/signup, the
// Better Auth endpoints, the WAHA inbound webhook (unauthenticated by design
// and protected by HMAC instead), static assets — is public by default.

import { getSessionCookie } from "better-auth/cookies";
import { type NextRequest, NextResponse } from "next/server";

/** Path prefix for the login flow; unauthenticated users are sent here. */
const LOGIN_PATH = "/login";

/**
 * Deny access to any matched route that lacks a session cookie (Req 21.1).
 * Page requests are redirected to the login page (carrying the original path
 * as `next` so the user returns after authenticating); internal data endpoints
 * receive a `401` instead of an HTML redirect.
 */
export function proxy(request: NextRequest): NextResponse {
	const sessionCookie = getSessionCookie(request);
	if (sessionCookie) {
		return NextResponse.next();
	}

	const { pathname, search } = request.nextUrl;

	// Internal data endpoints get a machine-readable denial, not a redirect.
	if (pathname.startsWith("/api/")) {
		return NextResponse.json({ error: "unauthorized" }, { status: 401 });
	}

	const loginUrl = new URL(LOGIN_PATH, request.url);
	loginUrl.searchParams.set("next", `${pathname}${search}`);
	return NextResponse.redirect(loginUrl);
}

/**
 * Guard only the CRM surface: its pages and its internal data endpoints. New
 * public routes (landing, blog, …) need no matcher change — routes are public
 * unless listed here.
 */
export const config = {
	matcher: ["/crm/:path*", "/api/crm/:path*"],
};
