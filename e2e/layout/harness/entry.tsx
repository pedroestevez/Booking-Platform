import { createRoot } from "react-dom/client";

import { TenantBookingPage } from "@/components/booking/tenant-booking-page";

import { RULES, SERVICES, TENANT } from "./fixtures";

/**
 * Client entry for the layout harness. It renders **the real page body** — the
 * same `TenantBookingPage` both tenant routes render (`/<slug>` and a tenant's
 * own domain at `/`) — so the ancestor chain the assertions measure is the
 * product's, not a replica of it.
 */
const container = document.getElementById("root");
if (!container) throw new Error("Harness container #root is missing.");

createRoot(container).render(
  <TenantBookingPage
    tenant={TENANT}
    services={SERVICES}
    rules={RULES}
    blocked={[]}
    bookings={[]}
  />,
);
