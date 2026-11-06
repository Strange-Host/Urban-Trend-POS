import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import useCashierHome from '../hooks/useCashierHome';
import useUiVersion from '../hooks/useUiVersion';
import POSTerminal from '../pages/POSTerminal';
import { homeRouteFor } from './navItems';

// Each role has its own home: the storekeeper has no till, so they land on the catalog instead.
export default function Home() {
  const { user, can } = useAuth();
  const { isV2 } = useUiVersion();
  const { home: cashierHome } = useCashierHome();
  // The rule lives in navItems.js so the rail's logo link and this landing page can't disagree. Admins and managers
  // open on the dashboard (graphs, alerts, KPIs), the storekeeper on the catalog, cashiers on the till.
  const home = homeRouteFor(user?.role, can);
  if (home !== '/terminal') return <Navigate to={home} replace />;
  // The new layout (ut_ui=v2) gives cashiers the Start screen (/start) as their home, unless they chose to open on the till from the
  // account menu. The current layout is unchanged: "/" is the till.
  if (isV2 && user?.role === 'cashier' && cashierHome === 'start') return <Navigate to="/start" replace />;
  return <POSTerminal />;
}
