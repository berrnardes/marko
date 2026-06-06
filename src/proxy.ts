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
// Public routes are excluded via the matcher below: the Better Auth endpoints
// (`/api/auth/*`), the login page, Next internals/static assets, and the
// WAHA inbound webhook (which is unauthenticated by design and protected by
// HMAC instead).

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
 * Guard the CRM surface while leaving public routes open. Excludes the Better
 * Auth endpoints, the login page, the public WAHA webhook, and Next internal
 * and static assets; everything else under the app is protected.
 */
export const config = {
	matcher: [
		"/((?!login|api/auth|api/waha/webhook|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
	],
};
