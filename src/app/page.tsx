// Root route — sends visitors to the CRM.
//
// The marketing landing page that used to live here was removed with the beta
// scope cuts (ADR-002): this deployment is the CRM application, not the public
// site. `/crm` performs its own session check and bounces unauthenticated
// visitors to `/login`, so this redirect is safe for anonymous traffic.

import { redirect } from "next/navigation";

export default function RootPage() {
	redirect("/crm");
}
