import { Suspense, lazy } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ToastProvider, DialogProvider } from './context/UIContext';
import ProtectedRoute from './components/ProtectedRoute';
import Layout from './components/Layout';
import Login from './pages/Login';
import POSTerminal from './pages/POSTerminal';

// Everything below is lazy: these are admin/back-office pages a given
// shift may never visit, and bundling them into the initial load means
// everyone pays for Payroll/Staff/Settings just to ring up a sale.
// Login and POSTerminal stay eager on purpose — Login is the
// unauthenticated entry point, POSTerminal is the landing page every
// shift hits immediately after it, and lazy-loading either would just
// trade a bundle-size win for a network round trip on the most common
// path through the app.
const ChangePassword = lazy(() => import('./pages/ChangePassword'));
const Security = lazy(() => import('./pages/Security'));
const Orders = lazy(() => import('./pages/Orders'));
const PaymentReconciliation = lazy(() => import('./pages/PaymentReconciliation'));
const MoneyAtRisk = lazy(() => import('./pages/MoneyAtRisk'));
const Attendance = lazy(() => import('./pages/Attendance'));
const Payroll = lazy(() => import('./pages/Payroll'));
const Employees = lazy(() => import('./pages/Employees'));
const Catalog = lazy(() => import('./pages/Catalog'));
const StockControl = lazy(() => import('./pages/StockControl'));
const SalesHistory = lazy(() => import('./pages/SalesHistory'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Reports = lazy(() => import('./pages/Reports'));
const ShopifySync = lazy(() => import('./pages/ShopifySync'));
const Leads = lazy(() => import('./pages/Leads'));
const Requisitions = lazy(() => import('./pages/Requisitions'));
const Finance = lazy(() => import('./pages/Finance'));
const Staff = lazy(() => import('./pages/Staff'));
const StaffLogs = lazy(() => import('./pages/StaffLogs'));
const Settings = lazy(() => import('./pages/Settings'));

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

// Same "Loading…" visual language Orders/etc. already use for in-page
// query loading states, just centered full-page for a route transition.
function RouteFallback() {
  return <div className="p-8 text-text-muted text-sm">Loading…</div>;
}

// The storekeeper has no till, so the Terminal is not their home: they land on the catalog instead.
function Home() {
  const { user } = useAuth();
  if (user?.role === 'store') return <Navigate to="/catalog" replace />;
  return <POSTerminal />;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <DialogProvider>
          <AuthProvider>
            <BrowserRouter>
          <Suspense fallback={<RouteFallback />}>
            <Routes>
              <Route path="/login" element={<Login />} />
              {/* No Layout/sidebar here, same as /login — this page must be
                  reachable while must_change_password blocks every other
                  authenticated route (see ProtectedRoute and middleware/auth.js). */}
              <Route path="/change-password" element={<ProtectedRoute><ChangePassword /></ProtectedRoute>} />
              <Route
                element={
                  <ProtectedRoute>
                    <Layout />
                  </ProtectedRoute>
                }
              >
                <Route path="/" element={<Home />} />
                <Route path="/security" element={<Security />} />
                <Route
                  path="/catalog"
                  element={
                    <ProtectedRoute roles={['admin', 'manager', 'store']} permission={['products.manage', 'products.propose']}>
                      <Catalog />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/stock"
                  element={
                    <ProtectedRoute permission={['stock.receive', 'stock.transfer', 'stock.count']}>
                      <StockControl />
                    </ProtectedRoute>
                  }
                />
                {/* Old separate Products/Categories/Inventory pages were merged into /catalog. */}
                <Route path="/products" element={<Navigate to="/catalog" replace />} />
                <Route path="/categories" element={<Navigate to="/catalog" replace />} />
                <Route path="/inventory" element={<Navigate to="/catalog" replace />} />
                <Route path="/sales" element={<SalesHistory />} />
                <Route
                  path="/orders"
                  element={<ProtectedRoute roles={['admin', 'manager', 'cashier']}><Orders /></ProtectedRoute>}
                />
                <Route
                  path="/money-at-risk"
                  element={<ProtectedRoute roles={['admin', 'manager']} permission="atrisk.view"><MoneyAtRisk /></ProtectedRoute>}
                />
                <Route
                  path="/reconciliation"
                  element={<ProtectedRoute roles={['admin', 'manager']} permission="payments.reconcile"><PaymentReconciliation /></ProtectedRoute>}
                />
                <Route path="/attendance" element={<ProtectedRoute module="hr"><Attendance /></ProtectedRoute>} />
                <Route
                  path="/payroll"
                  element={<ProtectedRoute module="hr" roles={['admin', 'manager']} permission="payroll.view"><Payroll /></ProtectedRoute>}
                />
                <Route
                  path="/employees"
                  element={<ProtectedRoute module="hr" roles={['admin']}><Employees /></ProtectedRoute>}
                />
                <Route
                  path="/shopify-sync"
                  element={
                    <ProtectedRoute roles={['admin', 'manager']} permission="shopify.sync">
                      <ShopifySync />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/dashboard"
                  element={
                    <ProtectedRoute roles={['admin', 'manager']} permission="reports.view">
                      <Dashboard />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/reports"
                  element={
                    <ProtectedRoute roles={['admin', 'manager']} permission="reports.view">
                      <Reports />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/leads"
                  element={
                    <ProtectedRoute roles={['admin', 'manager', 'cashier']}>
                      <Leads />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/requisitions"
                  element={
                    <ProtectedRoute module="hr" roles={['admin', 'manager', 'cashier']}>
                      <Requisitions />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/finance"
                  element={
                    <ProtectedRoute roles={['admin', 'manager']}>
                      <Finance />
                    </ProtectedRoute>
                  }
                />
                {/* Old separate Expenses/Payments pages were merged into /finance. */}
                <Route path="/expenses" element={<Navigate to="/finance" replace />} />
                <Route path="/payments" element={<Navigate to="/finance" replace />} />
                <Route
                  path="/staff"
                  element={
                    <ProtectedRoute roles={['admin']}>
                      <Staff />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/staff-logs"
                  element={
                    <ProtectedRoute roles={['admin']}>
                      <StaffLogs />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/settings"
                  element={
                    <ProtectedRoute roles={['admin']}>
                      <Settings />
                    </ProtectedRoute>
                  }
                />
              </Route>
            </Routes>
          </Suspense>
        </BrowserRouter>
          </AuthProvider>
        </DialogProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
