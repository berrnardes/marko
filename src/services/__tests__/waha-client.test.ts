import { describe, expect, it, vi } from "vitest";

import {
	createWahaClient,
	type FetchLike,
	type ResolvedNumber,
} from "@/services/waha-client";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A `numberId` resolver stub mapping any id to the session `"sess"`. */
const resolveNumber = async (): Promise<ResolvedNumber> => ({
	session: "sess",
	blocked: false,
});

/** Build a `fetch` that returns `body` as a 200 JSON response. */
function jsonFetch(body: unknown): FetchLike {
	return vi.fn(async () => ({
		ok: true,
		status: 200,
		statusText: "OK",
		json: async () => body,
		text: async () => JSON.stringify(body),
	})) as unknown as FetchLike;
}

/** A modern Brazilian mobile (DDD 47 + 9 + 8 digits) → a check-exists candidate. */
const BR_MOBILE = "+5547996334573";

function makeClient(fetch: FetchLike) {
	return createWahaClient({
		baseUrl: "http://waha.test",
		resolveNumber,
		fetch,
	});
}

// ---------------------------------------------------------------------------
// resolveSendTarget
// ---------------------------------------------------------------------------

describe("WahaClient.resolveSendTarget", () => {
	it("returns the canonical chat id as reachable when WAHA confirms the number exists", async () => {
		const fetch = jsonFetch({
			numberExists: true,
			chatId: "554796334573@c.us",
		});
		const waha = makeClient(fetch);

		await expect(waha.resolveSendTarget("num-1", BR_MOBILE)).resolves.toEqual({
			reachable: true,
			chatId: "554796334573@c.us",
		});
	});

	it("runs the existence check through the sending number's session", async () => {
		const fetch = jsonFetch({
			numberExists: true,
			chatId: "554796334573@c.us",
		});
		const waha = makeClient(fetch);

		await waha.resolveSendTarget("num-1", BR_MOBILE);
		const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
		expect(url).toContain("/api/contacts/check-exists");
		expect(url).toContain("session=sess");
	});

	it("returns reachable:false when WAHA confirms the number does not exist", async () => {
		const fetch = jsonFetch({ numberExists: false });
		const waha = makeClient(fetch);

		await expect(waha.resolveSendTarget("num-1", BR_MOBILE)).resolves.toEqual({
			reachable: false,
		});
	});

	it("falls back to the naive chat id (reachable) on a malformed/indeterminate response", async () => {
		const fetch = jsonFetch({}); // no `numberExists` field
		const waha = makeClient(fetch);

		await expect(waha.resolveSendTarget("num-1", BR_MOBILE)).resolves.toEqual({
			reachable: true,
			chatId: "5547996334573@c.us",
		});
	});

	it("falls back to the naive chat id (reachable) when the existence check fails — best-effort", async () => {
		const fetch = vi.fn(async () => {
			throw new Error("network down");
		}) as unknown as FetchLike;
		const waha = makeClient(fetch);

		await expect(waha.resolveSendTarget("num-1", BR_MOBILE)).resolves.toEqual({
			reachable: true,
			chatId: "5547996334573@c.us",
		});
	});

	it("falls back to the naive chat id (reachable) when the session resolver fails — best-effort", async () => {
		const fetch = jsonFetch({ numberExists: false });
		const waha = createWahaClient({
			baseUrl: "http://waha.test",
			resolveNumber: async () => {
				throw new Error("unknown numberId");
			},
			fetch,
		});

		await expect(waha.resolveSendTarget("num-1", BR_MOBILE)).resolves.toEqual({
			reachable: true,
			chatId: "5547996334573@c.us",
		});
		expect(fetch).not.toHaveBeenCalled();
	});

	it("never calls WAHA for a non-Brazilian-mobile number (no 9th-digit ambiguity)", async () => {
		const fetch = jsonFetch({ numberExists: false });
		const waha = makeClient(fetch);

		// A US number: not a Brazilian mobile candidate, so the gate is skipped.
		await expect(
			waha.resolveSendTarget("num-1", "+14155550123"),
		).resolves.toEqual({
			reachable: true,
			chatId: "14155550123@c.us",
		});
		expect(fetch).not.toHaveBeenCalled();
	});
});
