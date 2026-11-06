export function money(cents) {
  return (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'KES' });
}

export const STATUS_LABELS = {
  awaiting_dispatch: 'Awaiting dispatch',
  dispatched_unpaid: 'Dispatched · unpaid',
  dispatched_partial: 'Dispatched · part paid',
  dispatched_paid: 'Dispatched · paid',
  returned_in_transit: 'Returning',
  returned_awaiting_inspection: 'Awaiting inspection',
  returned_resellable: 'Returned · resellable',
  returned_damaged: 'Returned · damaged',
  cancelled: 'Cancelled',
};

export const STATUS_TONES = {
  awaiting_dispatch: 'neutral',
  dispatched_unpaid: 'danger',
  dispatched_partial: 'accent',
  dispatched_paid: 'success',
  returned_in_transit: 'accent',
  returned_awaiting_inspection: 'accent',
  returned_resellable: 'success',
  returned_damaged: 'danger',
  cancelled: 'neutral',
};

export const RETURN_REASONS = [
  { value: 'rejected', label: 'Customer rejected' },
  { value: 'damaged', label: 'Arrived damaged' },
  { value: 'wrong_item', label: 'Wrong item sent' },
];

// Same split as Sales history. The API calls the Local-store channel "manual" (orders created in the
// POS or from leads) and WooCommerce "wordpress".
export const CHANNELS = [
  { key: 'all', label: 'All channels' },
  { key: 'local', label: 'Local store' },
  { key: 'shopify', label: 'Shopify' },
  { key: 'woocommerce', label: 'WooCommerce' },
];
export const CHANNEL_PARAM = { all: undefined, local: 'manual', shopify: 'shopify', woocommerce: 'wordpress' };
