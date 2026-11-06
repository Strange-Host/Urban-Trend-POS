// Lead sources, status labels and colours, and the allowed next statuses, shared by the Leads page and its sheets.

export const SOURCES = ['whatsapp', 'walk_in', 'referral', 'shopify', 'other'];
export const STATUS_LABELS = { new: 'New', contacted: 'Contacted', rescheduled: 'Rescheduled', converted: 'Converted', cancelled: 'Lost' }; // the stored status stays 'cancelled'; it is shown as Lost
export const STATUS_COLORS = {
  new: 'bg-line text-text-muted',
  contacted: 'bg-accent/20 text-accent-text',
  rescheduled: 'bg-accent/20 text-accent-text',
  converted: 'bg-success-soft text-success',
  cancelled: 'bg-danger-soft text-danger',
};
// Mirrors the backend state machine — for UI affordance only; the server is the source of truth.
export const NEXT_STATUSES = {
  new: ['contacted', 'cancelled'],
  contacted: ['rescheduled', 'converted', 'cancelled'],
  rescheduled: ['contacted', 'converted', 'cancelled'],
  converted: [],
  cancelled: [],
};
export const emptyForm = { name: '', phone: '', email: '', source: 'walk_in', notes: '', assigned_staff_id: '' };
