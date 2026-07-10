// Shared mapping from a persisted WhatsApp `NumberRecord` to the CRM `NumberView`
// DTO. Extracted so both the list/create route and the session-confirm route
// return the same shape.

import type { NumberView } from "@/app/crm/_lib/types";
import type { NumberRecord } from "@/services/repositories";

export function toNumberView(record: NumberRecord): NumberView {
	return {
		id: record.id,
		sessionName: record.sessionName,
		msisdn: record.msisdn,
		blocked: record.blocked,
		dailySent: record.dailySent,
		dailyCounterDate: record.dailyCounterDate.toISOString(),
		warmupStartDate: record.warmupStartDate.toISOString(),
	};
}
