import type { AdjustReason, ApprovalType, OrderStatus, PaymentState } from "../api/types";

export const approvalTypeLabel: Record<ApprovalType, string> = {
  void: "Void",
  refund: "Refund",
  requisition: "Requisition",
  expense: "Expense",
  stock_adjustment: "Stock adjustment",
  duplicate_order: "Duplicate order",
};

export const orderStatusLabel: Record<OrderStatus, string> = {
  awaiting_dispatch: "Awaiting dispatch",
  dispatched_unpaid: "Dispatched, unpaid",
  dispatched_partial: "Dispatched, part paid",
  dispatched_paid: "Dispatched, paid",
  returned_in_transit: "Returning",
  returned_awaiting_inspection: "Returned, to inspect",
  returned_resellable: "Returned, resellable",
  returned_damaged: "Returned, damaged",
  cancelled: "Cancelled",
};

export const paymentLabel: Record<PaymentState, string> = {
  paid: "Paid",
  unpaid: "Unpaid",
  partial: "Part paid",
};

export const adjustReasons: { key: AdjustReason; label: string }[] = [
  { key: "damaged", label: "Damaged" },
  { key: "lost", label: "Lost" },
  { key: "found", label: "Found" },
  { key: "count_correction", label: "Count correction" },
  { key: "return_to_stock", label: "Return to stock" },
  { key: "other", label: "Other" },
];
