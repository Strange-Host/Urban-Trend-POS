import { Link } from 'react-router-dom';

// One destination on the rail: icon over a short label, a full-height touch target. The active one is filled amber.
export default function RailItem({ to, label, icon: Icon, active, onClick }) {
  return (
    <Link
      to={to}
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={`flex min-h-14 w-full flex-col items-center justify-center gap-1 rounded-xl px-1 py-2 text-center transition-colors ${
        active ? 'bg-accent text-accent-ink' : 'text-white/70 hover:bg-white/10 hover:text-white'
      }`}
    >
      <Icon size={20} strokeWidth={1.75} className="shrink-0" aria-hidden="true" />
      <span className="text-[11px] font-medium leading-tight">{label}</span>
    </Link>
  );
}
