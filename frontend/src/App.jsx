import { Suspense, lazy } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from './context/AuthContext';
import { ToastProvider, DialogProvider } from './context/UIContext';
import ProtectedRoute from './components/ProtectedRoute';
import ShellSwitch from './components/ShellSwitch';
import Home from './components/Home';
import { PageSkeleton } from './components/Skeleton';
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
// The cashier's Start screen: only people on the new layout reach it.
const Start = lazy(() => import('./pages/Start'));
const Orders = lazy(() => import('./pages/Orders'));
const PaymentReconciliation = lazy(() => import('./pages/PaymentReconciliation'));
const MoneyAtRisk = lazy(() => import('./pages/MoneyAtRisk'));
const Attendance = lazy(() => import('./pages/Attendance'));
const EndOfDay = lazy(() => import('./pages/EndOfDay'));
const Payroll = lazy(() => import('./pages/Payroll'));
const Employees = lazy(() => import('./pages/Employees'));
const Catalog = lazy(() => import('./pages/Catalog'));
const StockControl = lazy(() => import('./pages/StockControl'));
const SalesHistory = lazy(() => import('./pages/SalesHistory'));
const Approvals = lazy(() => import('./pages/Approvals'));
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

// Shown while a page's code downloads: a grey outline of a typical page instead of a line of text.
function RouteFallback() {
  return <PageSkeleton />;
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
                    <ShellSwitch />
                  </ProtectedRoute>
                }
              >
                <Route path="/" element={<Home />} />
                {/* The till itself. "/" is only each role's landing page (admins/managers go on to the dashboard), so the sidebar's Terminal link must point here. */}
                <Route path="/start" element={<ProtectedRoute roles={['admin', 'manager', 'cashier']}><Start /></ProtectedRoute>} />
                <Route path="/terminal" element={<ProtectedRoute roles={['admin', 'manager', 'cashier']}><POSTerminal /></ProtectedRoute>} />
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
                  path="/approvals"
                  element={<ProtectedRoute permission={['approvals.review', 'sales.void_request', 'payments.refund_request']}><Approvals /></ProtectedRoute>}
                />
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
                <Route path="/attendance/end-of-day" element={<ProtectedRoute module="hr"><EndOfDay /></ProtectedRoute>} />
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
