import client from '../client';
import { mapResponse, notImplemented } from './common';

// Couriers as the Orders page's picker reads them: { data: { data: [{ id, name, courier_type, vehicle, ... }] } }.
export function adaptCourier(c) {
  return {
    id: c.id,
    name: c.name,
    kind: c.kind,
    // The legacy screens know two kinds, Boda and G4S. The new server has riders and organizations; the label says which.
    courier_type: c.kind === 'organization' ? 'g4s' : 'boda',
    courier_label: c.kind === 'organization' ? 'Organization' : 'Rider',
    vehicle: c.vehiclePlate ?? null,
    phone: c.phone ?? null,
    is_active: c.active ? 1 : 0,
    collects_payment: Boolean(c.collectsPayment),
  };
}

export const newCouriersApi = {
  // Only active couriers can take a dispatch, so only those are offered.
  list: (params) => mapResponse(client.get('/couriers', { params: { ...(params || {}), active: 'true' } }), (d) => ({ data: d.couriers.map(adaptCourier) })),
  // Adding, editing and removing couriers belongs to the Couriers page (Finance), which is rewired in its own step.
  create: notImplemented('couriersApi.create'),
  update: notImplemented('couriersApi.update'),
  remove: notImplemented('couriersApi.remove'),
};
