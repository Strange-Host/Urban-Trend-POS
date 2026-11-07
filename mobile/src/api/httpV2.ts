import type { Page } from "./typesV11";
import type {
  ApiV2,
  DuplicateApproval,
  LeadConverted,
  LeadDetail,
  LeadsPage,
  ReturnItem,
  TelesalesOrder,
  TelesalesPage,
} from "./typesV2";

type Call = <T>(base: string, method: string, path: string, opts?: { token?: string; body?: unknown }) => Promise<T>;

const qs = (params: Record<string, string | number | undefined | null>): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

/** The real server's v2 endpoints (backend/src/routes/v1/index.js). Field names are passed through unchanged. */
export function createHttpV2(base: string, call: Call): ApiV2 {
  const get = <T,>(token: string, path: string) => call<T>(base, "GET", path, { token });
  const post = <T,>(token: string, path: string, body: unknown = {}) => call<T>(base, "POST", path, { token, body });
  const patch = <T,>(token: string, path: string, body: unknown) => call<T>(base, "PATCH", path, { token, body });

  return {
    telesalesOrders: (t, cursor) => get<TelesalesPage>(t, `/telesales/orders${qs({ cursor })}`),
    telesalesOrder: (t, id) => get<TelesalesOrder>(t, `/telesales/orders/${id}`),
    confirmOrder: (t, id) => post<TelesalesOrder>(t, `/orders/${id}/confirm`),
    rescheduleOrder: (t, id, callbackAt, note) => post<TelesalesOrder>(t, `/orders/${id}/reschedule`, { callbackAt, note: note || undefined }),
    cancelTelesalesOrder: (t, id, reason) => post<TelesalesOrder>(t, `/orders/${id}/cancel`, { reason }),
    requestDuplicateApproval: async (t, id, note) =>
      (await post<{ approval: DuplicateApproval | null }>(t, `/orders/${id}/duplicate-approval`, { note: note || undefined })).approval,

    leads: (t, f) => get<LeadsPage>(t, `/leads${qs({ status: f.status, q: f.q, cursor: f.cursor })}`),
    lead: (t, id) => get<LeadDetail>(t, `/leads/${id}`),
    updateLead: (t, id, p) => patch<LeadDetail>(t, `/leads/${id}`, p),
    addLeadActivity: (t, id, type, content) => post<LeadDetail>(t, `/leads/${id}/activities`, { type, content }),
    convertLead: (t, id, r) => post<LeadConverted>(t, `/leads/${id}/convert`, r),

    returns: (t, f) => get<Page<ReturnItem>>(t, `/returns${qs({ status: f.status, cursor: f.cursor })}`),
    findReturnable: async (t, q) => (await get<{ items: ReturnItem[] }>(t, `/returns/orders${qs({ q })}`)).items,
    receiveReturn: (t, r) => post<ReturnItem>(t, "/returns", r),
    decideReturn: (t, id, decision, note) => post<ReturnItem>(t, `/returns/${id}/decision`, { decision, note: note || undefined }),
  };
}
