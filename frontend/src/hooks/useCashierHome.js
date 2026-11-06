import { useSyncExternalStore } from 'react';
import { DEFAULT_CASHIER_HOME, getCashierHome, setCashierHome, subscribeCashierHome } from '../utils/cashierHome';

/** Where this browser's cashier opens: { home: 'start' | 'till', setHome }. Re-renders when it changes. */
export default function useCashierHome() {
  const home = useSyncExternalStore(subscribeCashierHome, getCashierHome, () => DEFAULT_CASHIER_HOME);
  return { home, setHome: setCashierHome };
}
