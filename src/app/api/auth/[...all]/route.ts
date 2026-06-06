// Better Auth HTTP endpoint (Req 21.2).
//
// Mounts the Better Auth handler at `/api/auth/*`, serving sign-in, sign-out,
// session, and related auth routes. This route is intentionally public — it is
// how an Operator authenticates — and is excluded from the session guard in
// `src/proxy.ts`.

import { toNextJsHandler } from "better-auth/next-js";

import { auth } from "@/services/auth";

export const { GET, POST } = toNextJsHandler(auth);
