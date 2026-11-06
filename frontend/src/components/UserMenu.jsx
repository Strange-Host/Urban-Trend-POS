import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronUp, Lock, LogOut, PanelLeft, ShieldCheck, ShoppingCart } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import ThemeSwitch from './ThemeSwitch';
import useCashierHome from '../hooks/useCashierHome';
import useUiVersion from '../hooks/useUiVersion';

const initials = (name) => (name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('') || '?';

// One menu for everything about "me": security & devices, lock, sign out. In the wide sidebar it is a
// full-width button (avatar, name, role) whose menu opens upwards; in the icon rail (lg+) it is just the
// avatar and the menu opens to the right. On phones the rail never applies, so it is always the wide form.
export default function UserMenu({ rail = false, onNavigate }) {
  const { user, logout, lock } = useAuth();
  const navigate = useNavigate();
  const { isV2, setVersion } = useUiVersion();
  const { home: cashierHome, setHome: setCashierHome } = useCashierHome();
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    const onKeyDown = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const run = (fn) => () => { setOpen(false); onNavigate?.(); fn(); };
  const itemClass = 'w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left rounded-lg hover:bg-white/10 transition-colors';

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account menu for ${user?.name || 'you'}`}
        className={`w-full flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-white/10 transition-colors text-left ${rail ? 'lg:justify-center lg:px-0' : ''}`}
      >
        <span className="w-8 h-8 shrink-0 rounded-full bg-accent text-accent-ink grid place-items-center text-xs font-bold" aria-hidden="true">
          {initials(user?.name)}
        </span>
        <span className={`min-w-0 flex-1 ${rail ? 'lg:hidden' : ''}`}>
          <span className="block text-sm font-medium text-white truncate">{user?.name}</span>
          <span className="block text-xs text-white/50 capitalize truncate">{user?.role}</span>
        </span>
        <ChevronUp size={16} aria-hidden="true" className={`text-white/40 shrink-0 transition-transform ${open ? '' : 'rotate-180'} ${rail ? 'lg:hidden' : ''}`} />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Account"
          className={`absolute z-50 bottom-full left-0 right-0 mb-2 bg-ink-soft text-white/90 border border-white/10 rounded-xl shadow-xl p-1.5 ${
            rail ? 'lg:bottom-0 lg:left-full lg:right-auto lg:mb-0 lg:ml-3 lg:w-56' : ''
          }`}
        >
          <div className="px-3 py-2 border-b border-white/10 mb-1">
            <div className="text-sm font-medium truncate">{user?.name}</div>
            <div className="text-xs text-white/50 capitalize">{user?.role}</div>
          </div>
          <button type="button" role="menuitem" className={itemClass} onClick={run(() => navigate('/security'))}>
            <ShieldCheck size={16} aria-hidden="true" /> Security &amp; devices
          </button>
          <ThemeSwitch />
          {/* Redesign preview: admins only, until the new layout replaces the current one. */}
          {user?.role === 'admin' && (
            <button type="button" role="menuitem" className={itemClass} onClick={run(() => setVersion(isV2 ? 'v1' : 'v2'))}>
              <PanelLeft size={16} aria-hidden="true" /> {isV2 ? 'Use current layout' : 'Try new layout'}
            </button>
          )}
          {/* New layout, cashiers only: open on the Start screen (default) or straight on the till. */}
          {isV2 && user?.role === 'cashier' && (
            <button type="button" role="menuitem" className={itemClass} onClick={run(() => setCashierHome(cashierHome === 'till' ? 'start' : 'till'))}>
              <ShoppingCart size={16} aria-hidden="true" /> {cashierHome === 'till' ? 'Open on the Start screen' : 'Open on the till'}
            </button>
          )}
          <button type="button" role="menuitem" className={itemClass} onClick={run(lock)}>
            <Lock size={16} aria-hidden="true" /> Lock screen
          </button>
          <button type="button" role="menuitem" className={itemClass} onClick={run(() => logout())}>
            <LogOut size={16} aria-hidden="true" /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}
