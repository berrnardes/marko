// WAHA session-admin client (server-only).
//
// Side-effect boundary: this is the WhatsApp *session lifecycle* client, the
// counterpart to the messaging `HttpWahaClient` in `./waha-client.ts`. It drives
// the WAHA session API used by the CRM numbers section to connect a new number:
// create + start a session, poll its status, fetch the scan QR, read the
// authenticated account, and tear a session down.
//
// It is deliberately separate from `HttpWahaClient` (which is constructed with a
// `NumberSessionResolver` it does not need and is wired into the outbound send
// path). Both talk to the same WAHA instance and share the transport style:
// `WAHA_BASE_URL` with a trailing-slash-trimmed base, and the `X-Api-Key`
// header from `WAHA_API_KEY`. The messaging `WahaError` is reused for failures.
//
// WAHA endpoints used (verified against waha.devlike.pro):
//   - `POST   /api/sessions`                    create + start (`{ name, start }`)
//   - `GET    /api/sessions/{session}`          status + authenticated `me`
//   - `GET    /api/{session}/auth/qr`           scan QR (base64 via Accept: json)
//   - `POST   /api/sessions/{session}/logout`   disconnect the account
//   - `DELETE /api/sessions/{session}`          remove the session entirely

import { WahaError } from "./waha-client";

/** WAHA session lifecycle states (subset we act on). */
export type WahaSessionStatus =
	| "STARTING"
	| "SCAN_QR_CODE"
	| "WORKING"
	| "FAILED"
	| "STOPPED";

/** Authenticated WhatsApp account as reported by WAHA once a session is WORKING. */
export interface WahaMe {
	/** WhatsApp id, e.g. `5511999999999@c.us`. */
	id: string;
	/** Display name of the connected account, when present. */
	pushName?: string;
}

/** A session's current state as surfaced to the CRM. */
export interface WahaSessionInfo {
	name: string;
	status: WahaSessionStatus;
	/** Present once the session is authenticated (`WORKING`); otherwise null. */
	me: WahaMe | null;
}

/** Injectable `fetch`, matching the messaging client's transport seam. */
type FetchLike = typeof globalThis.fetch;

/** Configuration for {@link HttpWahaAdminClient}. */
export interface WahaAdminClientConfig {
	/** WAHA base URL (e.g. `https://waha.example.com`); trailing slashes trimmed. */
	baseUrl: string;
	/** WAHA API key sent as `X-Api-Key`, when configured. */
	apiKey?: string;
	/** Injectable fetch; defaults to the global. */
	fetch?: FetchLike;
}

/**
 * Convert a WAHA `me.id` (`5511999999999@c.us`) into an E.164 `msisdn`
 * (`+5511999999999`). Returns null when no digits are present.
 */
export function msisdnFromMe(me: WahaMe | null): string | null {
	if (!me?.id) {
		return null;
	}
	const digits = me.id.split("@")[0]?.replace(/\D+/g, "") ?? "";
	return digits.length > 0 ? `+${digits}` : null;
}

/**
 * Concrete WAHA session-admin client over the REST API. Stateless; safe to
 * construct once and reuse (see the `wahaAdmin` singleton below).
 */
export class HttpWahaAdminClient {
	private readonly baseUrl: string;
	private readonly apiKey?: string;
	private readonly fetchImpl: FetchLike;

	constructor(config: WahaAdminClientConfig) {
		const fetchImpl = config.fetch ?? globalThis.fetch;
		if (typeof fetchImpl !== "function") {
			throw new WahaError(
				"No fetch implementation available; pass `fetch` in WahaAdminClientConfig",
			);
		}
		this.baseUrl = config.baseUrl.replace(/\/+$/, "");
		this.apiKey = config.apiKey;
		this.fetchImpl = fetchImpl;
	}

	/** Create and start a session with the given name. Idempotent-ish: a WAHA
	 * `422` (session already exists) is tolerated so a retried create is safe. */
	async createSession(name: string): Promise<WahaSessionInfo> {
		const res = await this.fetchImpl(this.url("/api/sessions"), {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify({ name, start: true }),
		});
		if (!res.ok && res.status !== 422) {
			throw await this.toError("POST", "/api/sessions", res);
		}
		// Whether freshly created or already existing, read the canonical state.
		return this.getSession(name);
	}

	/** Read a session's status and authenticated account. */
	async getSession(name: string): Promise<WahaSessionInfo> {
		const path = `/api/sessions/${encodeURIComponent(name)}`;
		const res = await this.fetchImpl(this.url(path), {
			method: "GET",
			headers: this.headers(),
		});
		if (!res.ok) {
			throw await this.toError("GET", path, res);
		}
		const payload = (await res.json()) as {
			status?: string;
			me?: WahaMe | null;
		};
		return {
			name,
			status: (payload.status as WahaSessionStatus) ?? "STARTING",
			me: payload.me ?? null,
		};
	}

	/**
	 * Fetch the scan QR as a `data:` URL for `<img>`. Requests JSON so WAHA
	 * returns a base64 payload rather than raw PNG bytes. Returns null when the
	 * session is simply not presenting a QR right now (e.g. already WORKING, or
	 * the state moved on between the status read and this call).
	 *
	 * Anything else — auth rejected, WAHA erroring, gateway down — throws. Those
	 * are real failures, and swallowing them as "no QR yet" would leave the
	 * connect UI waiting on a QR that is never coming.
	 */
	async getQrDataUrl(name: string): Promise<string | null> {
		const path = `/api/${encodeURIComponent(name)}/auth/qr`;
		const res = await this.fetchImpl(this.url(path), {
			method: "GET",
			headers: this.headers(),
		});
		if (res.status === 404 || res.status === 422) {
			// Unknown session / wrong state for a QR — expected, not an error.
			return null;
		}
		if (!res.ok) {
			throw await this.toError("GET", path, res);
		}
		const payload = (await res.json()) as {
			mimetype?: string;
			data?: string;
		};
		if (!payload?.data) {
			return null;
		}
		const mimetype = payload.mimetype ?? "image/png";
		return `data:${mimetype};base64,${payload.data}`;
	}

	/**
	 * Best-effort teardown: log the account out, then delete the session. Never
	 * throws — a number can be removed from the CRM even if WAHA is unreachable.
	 */
	async logoutAndDelete(name: string): Promise<void> {
		const encoded = encodeURIComponent(name);
		try {
			await this.fetchImpl(this.url(`/api/sessions/${encoded}/logout`), {
				method: "POST",
				headers: this.headers(),
			});
		} catch {
			// ignore — proceed to delete regardless.
		}
		try {
			await this.fetchImpl(this.url(`/api/sessions/${encoded}`), {
				method: "DELETE",
				headers: this.headers(),
			});
		} catch {
			// ignore — teardown is best-effort.
		}
	}

	/**
	 * The configured base URL, for diagnostics. Safe to log: it carries no
	 * credential (the API key travels in a header).
	 */
	get configuredBaseUrl(): string {
		return this.baseUrl;
	}

	/**
	 * Absolute URL for a WAHA path. An empty base means `WAHA_BASE_URL` was never
	 * set in this environment — a deployment mistake that otherwise surfaces as
	 * `fetch` failing to parse a relative URL, which reads like a network fault
	 * and sends whoever debugs it to the WAHA logs, where nothing ever arrived.
	 */
	private url(path: string): string {
		if (this.baseUrl === "") {
			throw new WahaError(
				"WAHA base URL is not configured: set WAHA_BASE_URL (e.g. https://waha.markohome.com.br)",
			);
		}
		return `${this.baseUrl}${path}`;
	}

	/** Build request headers, including the optional API key. */
	private headers(): Record<string, string> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json",
		};
		if (this.apiKey) {
			headers["X-Api-Key"] = this.apiKey;
		}
		return headers;
	}

	/** Build a {@link WahaError} from a failed response, reading its body. */
	private async toError(
		method: string,
		path: string,
		res: Response,
	): Promise<WahaError> {
		let detail: string | undefined;
		try {
			detail = await res.text();
		} catch {
			detail = undefined;
		}
		return new WahaError(
			`WAHA ${method} ${path} failed: ${res.status} ${res.statusText}`,
			res.status,
			detail,
		);
	}
}

/**
 * Process-wide session-admin client wired from the environment. Reads
 * `WAHA_BASE_URL` and `WAHA_API_KEY` — the same variables the messaging client
 * uses — so the Next app's CRM routes can drive session onboarding directly.
 */
export const wahaAdmin = new HttpWahaAdminClient({
	baseUrl: process.env.WAHA_BASE_URL ?? "",
	apiKey: process.env.WAHA_API_KEY,
});
