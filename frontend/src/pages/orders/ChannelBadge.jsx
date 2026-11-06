import { CHANNEL_BADGE } from './helpers';

export default function ChannelBadge({ order }) {
  const b = CHANNEL_BADGE[order.channel];
  if (!b) return null;
  return <span title={order.income_source_name || b.label} className={`ml-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${b.cls}`}>{b.label}</span>;
}
