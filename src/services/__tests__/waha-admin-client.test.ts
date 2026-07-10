// Unit tests for the WAHA session-admin client.
//
// These exercise the pure `msisdnFromMe` helper and the transport parsing of
// `HttpWahaAdminClient` against an injected fake `fetch`: status/`me` reading,
// QR base64 → data URL conversion, and the "no QR available" path. Network
// shape follows the WAHA REST API used by the CRM connect flow.

import { describe, expect, it, vi } from "vitest";

import {
	HttpWahaAdminClient,
	msisdnFromMe,
} from "@/services/waha-admin-client";

/** Build a client over a fetch that returns a canned JSON body + status. */
function clientReturning(body: unknown, status = 200): HttpWahaAdminClient {
	const fetchImpl = vi.fn(async () =>
		new Response(JSON.stringify(body), {
			status,
			headers: { "Content-Type": "application/json" },
		}),
	);
	return new HttpWahaAdminClient({
		baseUrl: "https://waha.example.com/",
		apiKey: "k",
		fetch: fetchImpl as unknown as typeof globalThis.fetch,
	});
}

describe("msisdnFromMe", () => {
	it("converts a WAHA me.id to E.164", () => {
		expect(msisdnFromMe({ id: "5511999999999@c.us" })).toBe("+5511999999999");
	});

	it("returns null for a missing or empty account", () => {
		expect(msisdnFromMe(null)).toBeNull();
		expect(msisdnFromMe({ id: "" })).toBeNull();
		expect(msisdnFromMe({ id: "@c.us" })).toBeNull();
	});
});

describe("HttpWahaAdminClient.getSession", () => {
	it("surfaces status and authenticated account", async () => {
		const client = clientReturning({
			status: "WORKING",
			me: { id: "5511999999999@c.us", pushName: "Marko" },
		});
		const info = await client.getSession("wa-123");
		expect(info.status).toBe("WORKING");
		expect(info.me?.id).toBe("5511999999999@c.us");
		expect(msisdnFromMe(info.me)).toBe("+5511999999999");
	});

	it("defaults me to null when absent", async () => {
		const client = clientReturning({ status: "SCAN_QR_CODE" });
		const info = await client.getSession("wa-123");
		expect(info.status).toBe("SCAN_QR_CODE");
		expect(info.me).toBeNull();
	});
});

describe("HttpWahaAdminClient.getQrDataUrl", () => {
	it("wraps a base64 QR payload as a data URL", async () => {
		const client = clientReturning({ mimetype: "image/png", data: "AAAA" });
		expect(await client.getQrDataUrl("wa-123")).toBe(
			"data:image/png;base64,AAAA",
		);
	});

	it("returns null when no QR is available", async () => {
		const client = clientReturning({}, 404);
		expect(await client.getQrDataUrl("wa-123")).toBeNull();
	});
});
