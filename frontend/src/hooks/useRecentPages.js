import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { ALL_ITEMS } from '../components/navItems';

// The pages this person opened most recently, newest first. Feeds the "Recent" shortcuts in the sidebar
// and the Ctrl+K palette. Only pages that are in the navigation count (not /security or a login screen),
// and it is kept per browser, so a shared till doesn't leak one cashier's habits to another account:
// the list holds nothing but route paths, and anything the person may not open is filtered out when shown.
const KEY = 'ut_recent_pages';
const MAX = 8;
const KNOWN = new Set(ALL_ITEMS.map((i) => i.to));

function read() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(list) ? list.filter((p) => KNOWN.has(p)).slice(0, MAX) : [];
  } catch {
    return [];
  }
}

export default function useRecentPages() {
  const { pathname } = useLocation();
  const [recent, setRecent] = useState(read);

  useEffect(() => {
    if (!KNOWN.has(pathname)) return;
    setRecent((prev) => {
      if (prev[0] === pathname) return prev;
      const next = [pathname, ...prev.filter((p) => p !== pathname)].slice(0, MAX);
      try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* storage unavailable — the list just won't persist */ }
      return next;
    });
  }, [pathname]);

  return recent;
}
