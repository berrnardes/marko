// WAHA client (I/O boundary — outbound WhatsApp transport).
//
// Implements the design's `WAHA_Client`: the only component that talks to the
// self-hosted WAHA REST API for outbound text (`sendText`), human-like typing
// presence (`startTyping`/`stopTyping`, Req 17.2), and inbound read receipts
// (`sendSeen`, Req 17.3), plus canonical chat-id resolution for Brazilian
// pre-2012 numbers (`resolveChatId`).
//
// Side-effect boundary: this module performs network I/O against WAHA and
// nothing else. Both seams that make it impure are injected so it is unit
// testable without a live WAHA instance:
//   - the HTTP transport (a `fetch`-like function + base URL/api key), and
//   - the numberId -> WAHA `session` resolution (a `NumberSessionResolver`,
//     adaptable from a `NumberRepository`).
// It deliberately performs no pacing/delay or send-window math — that lives in
// the pure core (`@/core` anti-ban) and is enforced by the Outbound_Worker's
// choke point (a later task). This module is a transport.
//
// Block-flag note (Req 18.2): the authoritative block-flag gate is the
// Anti_Ban_Controller / Outbound_Worker choke point (see design "Outbound
// choke point"). Because resolving a number's session already reads its
// `NumberRecord` (which carries `blocked`), this client additionally refuses to
// `sendText` from a number whose block flag is set, so the design intent of
// Req 18.2 ("a blocked number SHALL NOT send outbound messages") is honored at
// the transport boundary as a defense-in-depth guard rather than the sole gate.

import type { NumberRepository } from "./repositories";

/**
 * The outbound integration boundary to the WAHA REST API. Mirrors the design's
 * `WAHA_Client` interface exactly. Every method takes a domain `numberId`
 * (mapped internally to a WAHA `session` via the injected resolver) except
 * {@link WahaClient.resolveChatId}, which maps an E.164 number to the canonical
 * WhatsApp `chatId`.
 */
export interface WahaClient {
	/**
	 * Resolve an E.164 number to its canonical WhatsApp `chatId`, handling the
	 * Brazilian pre-2012 9th-digit ambiguity and caching the result per number
	 * so repeated calls for the same E.164 do not re-hit WAHA.
	 */
	resolveChatId(e164: string): Promise<string>;
	/**
	 * Send an outbound text message and return its WAHA message id (Req 17.2
	 * path). Refuses to send from a number whose block flag is set (Req 18.2).
	 */
	sendText(
		numberId: string,
		chatId: string,
		text: string,
	): Promise<{ waMessageId: string }>;
	/** Begin simulated typing presence on a chat before sending (Req 17.2). */
	startTyping(numberId: string, chatId: string): Promise<void>;
	/** Stop simulated typing presence on a chat (Req 17.2). */
	stopTyping(numberId: string, chatId: string): Promise<void>;
	/** Mark inbound messages as seen (read receipts) (Req 17.3). */
	sendSeen(
		numberId: string,
		chatId: string,
		messageIds: string[],
	): Promise<void>;
	/**
	 * Resolve a WhatsApp hidden Linked ID (`@lid`) to its phone-number chat id
	 * (`@c.us`) via WAHA's Lids API, or `null` when WAHA has no mapping (the
	 * sender is unknown to the session / not in its contacts or groups). Used by
	 * the inbound webhook to attribute a `@lid` sender to a real phone number.
	 */
	resolveLidToPhone(session: string, lid: string): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Injectable transport + session seams
// ---------------------------------------------------------------------------

/**
 * A `fetch`-like function. Defaults to the global `fetch` (Node >= 20) but is
 * injectable so the client can be exercised against a fake transport in tests
 * with no live WAHA instance.
 */
export type FetchLike = typeof fetch;

/**
 * The per-number routing information the client needs to address WAHA: the
 * WAHA `session` that owns the number and its current block flag. Both are read
 * from the number's `NumberRecord`, so resolving a session and checking the
 * block flag are a single lookup.
 */
export interface ResolvedNumber {
	/** The WAHA session name owning this number (`NumberRecord.sessionName`). */
	session: string;
	/** Whether the number's block flag is set (Req 18). */
	blocked: boolean;
}

/**
 * Seam mapping a domain `numberId` to its {@link ResolvedNumber}. Injected so
 * the client never depends on the persistence layer directly; build one from a
 * `NumberRepository` with {@link numberSessionResolverFromRepository}.
 */
export type NumberSessionResolver = (
	numberId: string,
) => Promise<ResolvedNumber>;

/** Construction configuration for {@link HttpWahaClient}. */
export interface WahaClientConfig {
	/** Base URL of the WAHA REST API, e.g. `"http://localhost:3000"`. */
	baseUrl: string;
	/** Resolves a domain `numberId` to its WAHA session + block state. */
	resolveNumber: NumberSessionResolver;
	/** Optional API key sent as the `X-Api-Key` header on every request. */
	apiKey?: string;
	/**
	 * Injected `fetch` implementation. Defaults to the global `fetch`; supply a
	 * fake in tests. Throws at construction if neither is available.
	 */
	fetch?: FetchLike;
	/**
	 * WAHA session used by {@link WahaClient.resolveChatId} to call the
	 * "check phone number exists" endpoint. The interface signature carries no
	 * `numberId`, so a session is configured here. When omitted, chat-id
	 * resolution falls back to naive `<digits>@c.us` concatenation without the
	 * existence check.
	 */
	resolutionSession?: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Raised when a WAHA REST call fails or returns an unusable response. */
export class WahaError extends Error {
	/** HTTP status code, when the failure originated from a response. */
	readonly status?: number;
	/** Response body text, when available, for diagnostics. */
	readonly detail?: string;

	constructor(message: string, status?: number, detail?: string) {
		super(message);
		this.name = "WahaError";
		this.status = status;
		this.detail = detail;
	}
}

/**
 * Raised by {@link WahaClient.sendText} when the target number's block flag is
 * set, enforcing Req 18.2 at the transport boundary.
 */
export class WahaNumberBlockedError extends WahaError {
	/** The blocked domain `numberId` that was asked to send. */
	readonly numberId: string;

	constructor(numberId: string) {
		super(`Number "${numberId}" is blocked; refusing to send (Req 18.2)`);
		this.name = "WahaNumberBlockedError";
		this.numberId = numberId;
	}
}

// ---------------------------------------------------------------------------
// Internal helpers (pure)
// ---------------------------------------------------------------------------

/** Shape of WAHA's "check phone number exists" response (subset we read). */
interface CheckExistsResponse {
	numberExists?: boolean;
	chatId?: string;
}

/** Read a response body as text without throwing, for error diagnostics. */
async function safeReadText(res: Response): Promise<string | undefined> {
	try {
		return await res.text();
	} catch {
		return undefined;
	}
}

/**
 * Extract the WhatsApp message id from a WAHA `sendText` response, tolerating
 * the few shapes WAHA versions return: a string `id`, an object `id` with
 * `_serialized`/`id`, or the same nested under `_data`. Throws a
 * {@link WahaError} when no id can be found, since the caller relies on it to
 * track the sent message.
 */
function extractWaMessageId(payload: unknown): string {
	if (payload && typeof payload === "object") {
		const root = payload as Record<string, unknown>;
		const fromId = readId(root.id);
		if (fromId) {
			return fromId;
		}
		const data = root._data;
		if (data && typeof data === "object") {
			const fromData = readId((data as Record<string, unknown>).id);
			if (fromData) {
				return fromData;
			}
		}
	}
	throw new WahaError("WAHA sendText response did not include a message id");
}

/** Read a message id from WAHA's polymorphic `id` field. */
function readId(id: unknown): string | null {
	if (typeof id === "string" && id.length > 0) {
		return id;
	}
	if (id && typeof id === "object") {
		const obj = id as Record<string, unknown>;
		if (typeof obj._serialized === "string" && obj._serialized.length > 0) {
			return obj._serialized;
		}
		if (typeof obj.id === "string" && obj.id.length > 0) {
			return obj.id;
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// HttpWahaClient
// ---------------------------------------------------------------------------

/**
 * Concrete {@link WahaClient} backed by the WAHA REST API over an injectable
 * `fetch`. Stateless except for the per-number `chatId` resolution cache.
 *
 * WAHA endpoints used (from the design's "WAHA integration facts"):
 *   - `POST /api/sendText` with `{ session, chatId, text }`            (Req 17.2)
 *   - `POST /api/{session}/presence` with `{ chatId, presence }`       (Req 17.2)
 *   - `POST /api/sendSeen` with `{ session, chatId, messageIds }`      (Req 17.3)
 *   - `GET  /api/contacts/check-exists?phone=&session=`  (chat-id resolution)
 *   - `GET  /api/{session}/lids/{lid}`                   (LID → phone mapping)
 */
export class HttpWahaClient implements WahaClient {
	private readonly baseUrl: string;
	private readonly apiKey?: string;
	private readonly fetchImpl: FetchLike;
	private readonly resolveNumber: NumberSessionResolver;
	private readonly resolutionSession?: string;
	/**
	 * Per-E.164 canonical `chatId` cache. Stores the in-flight promise so
	 * concurrent calls for the same number share one lookup; a rejected lookup
	 * is evicted so a later call can retry (Req: resolve & cache per number).
	 */
	private readonly chatIdCache = new Map<string, Promise<string>>();

	constructor(config: WahaClientConfig) {
		const fetchImpl = config.fetch ?? globalThis.fetch;
		if (typeof fetchImpl !== "function") {
			throw new WahaError(
				"No fetch implementation available; pass `fetch` in WahaClientConfig",
			);
		}
		this.baseUrl = config.baseUrl.replace(/\/+$/, "");
		this.apiKey = config.apiKey;
		this.fetchImpl = fetchImpl;
		this.resolveNumber = config.resolveNumber;
		this.resolutionSession = config.resolutionSession;
	}

	/** @inheritdoc */
	async resolveChatId(e164: string): Promise<string> {
		const cached = this.chatIdCache.get(e164);
		if (cached) {
			return cached;
		}
		const pending = this.resolveChatIdUncached(e164).catch((err: unknown) => {
			// Do not poison the cache on failure: evict so a later call can retry.
			this.chatIdCache.delete(e164);
			throw err;
		});
		this.chatIdCache.set(e164, pending);
		return pending;
	}

	/** @inheritdoc */
	async sendText(
		numberId: string,
		chatId: string,
		text: string,
	): Promise<{ waMessageId: string }> {
		const { session, blocked } = await this.resolveNumber(numberId);
		// Req 18.2: a blocked number must not send any outbound message.
		if (blocked) {
			throw new WahaNumberBlockedError(numberId);
		}
		const res = await this.post("/api/sendText", { session, chatId, text });
		const payload: unknown = await res.json();
		return { waMessageId: extractWaMessageId(payload) };
	}

	/** @inheritdoc */
	async startTyping(numberId: string, chatId: string): Promise<void> {
		await this.setPresence(numberId, chatId, "typing");
	}

	/** @inheritdoc */
	async stopTyping(numberId: string, chatId: string): Promise<void> {
		await this.setPresence(numberId, chatId, "paused");
	}

	/** @inheritdoc */
	async sendSeen(
		numberId: string,
		chatId: string,
		messageIds: string[],
	): Promise<void> {
		const { session } = await this.resolveNumber(numberId);
		await this.post("/api/sendSeen", { session, chatId, messageIds });
	}

	/** @inheritdoc */
	async resolveLidToPhone(
		session: string,
		lid: string,
	): Promise<string | null> {
		// Accept either a bare lid number or a full `<digits>@lid` chat id; WAHA
		// wants the `@` escaped (or just the digits), so strip to digits.
		const digits = lid.replace(/\D+/g, "");
		if (digits.length === 0) {
			return null;
		}
		const path = `/api/${encodeURIComponent(session)}/lids/${digits}`;
		let res: Response;
		try {
			res = await this.get(path);
		} catch {
			// WAHA returns non-2xx (e.g. 404) when it has no mapping for the lid;
			// treat any failure as "unresolved" rather than throwing, so the webhook
			// can decide how to handle an unattributable sender.
			return null;
		}
		const payload = (await res.json()) as { pn?: unknown };
		if (typeof payload?.pn === "string" && payload.pn.length > 0) {
			return payload.pn;
		}
		return null;
	}

	// -- internals ----------------------------------------------------------

	/**
	 * Set typing presence for a chat (Req 17.2) via
	 * `POST /api/{session}/presence`. `"typing"` starts the indicator,
	 * `"paused"` stops it.
	 */
	private async setPresence(
		numberId: string,
		chatId: string,
		presence: "typing" | "paused",
	): Promise<void> {
		const { session } = await this.resolveNumber(numberId);
		const path = `/api/${encodeURIComponent(session)}/presence`;
		await this.post(path, { chatId, presence });
	}

	/** Resolve a canonical `chatId` without consulting the cache. */
	private async resolveChatIdUncached(e164: string): Promise<string> {
		const digits = e164.replace(/\D+/g, "");
		if (digits.length === 0) {
			throw new WahaError(
				`Cannot resolve chatId for empty/invalid number "${e164}"`,
			);
		}
		const naive = `${digits}@c.us`;
		// Only Brazilian mobile numbers carry the pre-2012 9th-digit ambiguity
		// that the existence check disambiguates; everything else uses the naive
		// form. The check also needs a configured resolution session.
		if (!this.resolutionSession || !isBrazilianMobileCandidate(digits)) {
			return naive;
		}
		try {
			const canonical = await this.checkPhoneExists(
				digits,
				this.resolutionSession,
			);
			return canonical ?? naive;
		} catch {
			// Best-effort: never block a send because the existence check failed.
			return naive;
		}
	}

	/**
	 * Call WAHA's "check phone number exists" endpoint, returning the canonical
	 * `chatId` when WAHA reports the number exists, else `null`.
	 */
	private async checkPhoneExists(
		digits: string,
		session: string,
	): Promise<string | null> {
		const query = new URLSearchParams({ phone: digits, session });
		const res = await this.get(
			`/api/contacts/check-exists?${query.toString()}`,
		);
		const payload = (await res.json()) as CheckExistsResponse;
		if (
			payload?.numberExists === true &&
			typeof payload.chatId === "string" &&
			payload.chatId.length > 0
		) {
			return payload.chatId;
		}
		return null;
	}

	/** Issue a `POST` with a JSON body, throwing {@link WahaError} on non-2xx. */
	private async post(path: string, body: unknown): Promise<Response> {
		const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			throw new WahaError(
				`WAHA POST ${path} failed: ${res.status} ${res.statusText}`,
				res.status,
				await safeReadText(res),
			);
		}
		return res;
	}

	/** Issue a `GET`, throwing {@link WahaError} on non-2xx. */
	private async get(path: string): Promise<Response> {
		const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
			method: "GET",
			headers: this.headers(),
		});
		if (!res.ok) {
			throw new WahaError(
				`WAHA GET ${path} failed: ${res.status} ${res.statusText}`,
				res.status,
				await safeReadText(res),
			);
		}
		return res;
	}

	/** Build the request headers, including the optional API key. */
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
}

/**
 * Decide whether a digit string is a Brazilian mobile number that may be
 * affected by the pre-2012 9th-digit ambiguity, and so is worth resolving via
 * WAHA's existence check rather than naive `@c.us` concatenation.
 *
 * Matches BR numbers (country code `55`) in either ambiguous mobile form:
 *   - modern mobile: `55` + 2-digit DDD + `9` + 8 digits (13 digits total), or
 *   - pre-2012 short form: `55` + 2-digit DDD + 8 digits (12 digits total).
 */
function isBrazilianMobileCandidate(digits: string): boolean {
	if (!digits.startsWith("55")) {
		return false;
	}
	const national = digits.slice(2);
	// 11 national digits with a leading 9 on the subscriber → modern mobile.
	if (national.length === 11 && national[2] === "9") {
		return true;
	}
	// 10 national digits → pre-2012 short form (the case the check disambiguates).
	return national.length === 10;
}

// ---------------------------------------------------------------------------
// Factory + repository adapter
// ---------------------------------------------------------------------------

/** Construct a {@link WahaClient} from {@link WahaClientConfig}. */
export function createWahaClient(config: WahaClientConfig): WahaClient {
	return new HttpWahaClient(config);
}

/**
 * Adapt a {@link NumberRepository} into a {@link NumberSessionResolver}: looks
 * up the `NumberRecord` by id and surfaces its `sessionName` and `blocked`
 * flag. Throws {@link WahaError} when the number is unknown.
 */
export function numberSessionResolverFromRepository(
	numbers: Pick<NumberRepository, "findById">,
): NumberSessionResolver {
	return async (numberId: string): Promise<ResolvedNumber> => {
		const record = await numbers.findById(numberId);
		if (!record) {
			throw new WahaError(
				`No WhatsApp number found for numberId "${numberId}"`,
			);
		}
		return { session: record.sessionName, blocked: record.blocked };
	};
}
