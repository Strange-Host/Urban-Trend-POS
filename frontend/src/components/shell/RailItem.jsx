import { Link } from 'react-router-dom';

// One destination on the rail: icon over a short label. Compact for mouse use; touch screens (pointer: coarse) keep the
// full 56px target. The active one is filled amber.
export default function RailItem({ to, label, icon: Icon, active, onClick }) {
  return (
    <Link
      to={to}
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={`flex min-h-12 w-full flex-col items-center justify-center gap-0.5 rounded-xl px-1 py-1.5 text-center pointer-coarse:min-h-14 pointer-coarse:gap-1 pointer-coarse:py-2 transition-colors ${
        active ? 'bg-accent text-accent-ink' : 'text-white/70 hover:bg-white/10 hover:text-white'
      }`}
    >
      <Icon size={18} strokeWidth={1.75} className="shrink-0" aria-hidden="true" />
      <span className="text-[10px] font-medium leading-tight">{label}</span>
    </Link>
  );
}
