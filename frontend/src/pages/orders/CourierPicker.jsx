import { useQuery } from '@tanstack/react-query';
import { couriersApi } from '../../api/endpoints';

// Optional: pick a NAMED courier (their type is applied automatically). The
// Boda / G4S buttons above still work on their own for when you don't care who.
export default function CourierPicker({ order, disabled, onPick }) {
  const { data: couriers = [] } = useQuery({
    queryKey: ['couriers'],
    queryFn: () => couriersApi.list().then((r) => r.data.data),
    staleTime: 60_000,
  });
  if (couriers.length === 0) return null;
  return (
    <select
      value={order.courier_id || ''}
      disabled={disabled}
      onChange={(e) => e.target.value && onPick(Number(e.target.value))}
      aria-label="Assign a named courier"
      className="w-full px-3 py-2 rounded-lg border border-line bg-surface text-xs outline-none focus:border-accent"
    >
      <option value="">Assign a named courier (optional)…</option>
      {couriers.map((c) => (
        <option key={c.id} value={c.id}>{c.name} — {c.courier_type === 'g4s' ? 'G4S' : 'Boda'}{c.vehicle ? ` · ${c.vehicle}` : ''}</option>
      ))}
    </select>
  );
}
