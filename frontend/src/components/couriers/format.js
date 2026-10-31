// Shared by the courier payables screens. All amounts from the API are integer cents.
export const money = (c) => `KES ${((c || 0) / 100).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const shortDate = (s) => (s ? String(s).slice(0, 10) : '');
export const inputCls = 'w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent text-sm';

export const COST_KIND_LABELS = {
  return_trip: 'Return trip', fuel: 'Fuel', airtime: 'Airtime', handling: 'Handling', repair: 'Repair', other: 'Other',
};
export const METHOD_LABELS = { mpesa: 'M-Pesa', bank: 'Bank', cash: 'Cash', netted_on_remittance: 'Netted on remittance' };
export const COST_TONE = { pending: 'accent', approved: 'success', rejected: 'danger' };
