export const inputCls = 'w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent';
export const labelCls = 'block text-xs font-medium text-text-muted mb-1';
export const btnPrimary = 'px-4 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft transition-colors whitespace-nowrap disabled:opacity-50';
export const btnGhost = 'px-3 py-2 rounded-lg border border-line text-sm font-medium hover:bg-paper whitespace-nowrap';
export const cardCls = 'bg-surface border border-line rounded-xl';

export const kes = (cents) => `KES ${(cents / 100).toLocaleString('en-KE', { maximumFractionDigits: 0 })}`;
export const toCents = (v) => Math.round(parseFloat(v) * 100);
export const when = (ts) => (ts ? String(ts).replace('T', ' ').slice(0, 16) : '');

export const ISSUE_REASONS = [
  { value: 'damaged', label: 'Damaged' }, { value: 'expired', label: 'Expired' }, { value: 'lost', label: 'Lost' },
  { value: 'internal_use', label: 'Used in the shop' }, { value: 'returned_to_supplier', label: 'Returned to supplier' }, { value: 'other', label: 'Other' },
];
export const ACTIVITY_LABEL = {
  receipt: 'Received a shipment', issue: 'Issued stock out', transfer_out: 'Stock left on a transfer', transfer_in: 'Stock arrived on a transfer',
  stocktake: 'Stock corrected to a count', adjustment: 'Adjusted stock', restock: 'Restocked', return: 'Customer return', void: 'Sale voided', requisition: 'Requisition',
  dispatch: 'Order dispatched', return_resellable: 'Return put back on the shelf',
  count_opening_submitted: 'Submitted the opening count', count_closing_submitted: 'Submitted the closing count',
  count_opening_approved: 'Approved an opening count', count_closing_approved: 'Approved a closing count',
  count_opening_rejected: 'Rejected an opening count', count_closing_rejected: 'Rejected a closing count',
  transfer_requested: 'Requested a transfer', transfer_approved: 'Approved a transfer', transfer_rejected: 'Rejected a transfer', transfer_cancelled: 'Withdrew a transfer',
};
