import { useState, useEffect, useCallback, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { lazyWithRetry as lazy } from './utils/lazyWithRetry';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Layout } from './components/Layout';
import { ToastProvider } from './components/Toast';
import { useRole } from './hooks/useRole';
import { RoleProvider } from './components/RoleProvider';
import { ErrorBoundary } from './components/ErrorBoundary';
import { TawkToChat } from './components/TawkToChat';
import { API_BASE_URL } from './services/api';
import { clearActorState, isUserRole, resolveStartupValidation } from './utils/authLifecycle';
import './App.css';

const Login = lazy(() => import('./pages/Login').then(m => ({ default: m.Login })));
const Dashboard = lazy(() => import('./pages/Dashboard').then(m => ({ default: m.Dashboard })));
const Sessions = lazy(() => import('./pages/Sessions').then(m => ({ default: m.Sessions })));
const Chats = lazy(() => import('./pages/Chats').then(m => ({ default: m.Chats })));
const Webhooks = lazy(() => import('./pages/Webhooks').then(m => ({ default: m.Webhooks })));
const Templates = lazy(() => import('./pages/Templates').then(m => ({ default: m.Templates })));
const Logs = lazy(() => import('./pages/Logs').then(m => ({ default: m.Logs })));
const ApiKeys = lazy(() => import('./pages/ApiKeys').then(m => ({ default: m.ApiKeys })));
const MessageTester = lazy(() => import('./pages/MessageTester').then(m => ({ default: m.MessageTester })));
const Infrastructure = lazy(() => import('./pages/Infrastructure').then(m => ({ default: m.Infrastructure })));
const Plugins = lazy(() => import('./pages/Plugins'));
const Billing = lazy(() => import('./pages/Billing').then(m => ({ default: m.Billing })));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});

function AppContent() {
  // Capture the key ONCE at mount. Read live per render, the null→key transition when
  // handleLogin stores a fresh key would re-fire the startup re-validation effect below and
  // double the /auth/validate request on every sign-in — the effect is for genuine page
  // refreshes with a saved key only.
  const [savedKey] = useState(() => sessionStorage.getItem('openwa_api_key'));
  const [savedAccount] = useState(() => sessionStorage.getItem('openwa_account') === '1');
  const [isAuthenticated, setIsAuthenticated] = useState(!!savedKey || savedAccount);
  const { setRole, role, setEngineType, setScoped, scoped } = useRole();

  const handleLogin = (validatedRole?: string, engineType?: string, scoped = false) => {
    sessionStorage.setItem('openwa_account', '1');
    sessionStorage.removeItem('openwa_api_key');

    // The login page's validate response already carried the role, so no second /auth/validate
    // round-trip is needed here. An absent or unrecognized role falls back to viewer, the
    // least-privileged default.
    setRole(isUserRole(validatedRole) ? validatedRole : 'viewer');
    setEngineType(engineType ?? null);
    setScoped(scoped);

    setIsAuthenticated(true);
  };

  const handleLogout = useCallback(() => {
    void fetch(`${API_BASE_URL}/account/sign-out`, { method: 'POST', credentials: 'include' }).catch(() => undefined);
    setIsAuthenticated(false);
    setRole(null);
    setEngineType(null);
    setScoped(false);
    sessionStorage.removeItem('openwa_api_key');
    sessionStorage.removeItem('openwa_account');
    // Wipe the React Query cache too: it is keyed by resource, not actor, so without a full
    // clear a logout → login in the same tab with a different key/scope shows the previous
    // actor's sessions/messages/apiKeys/audit rows.
    clearActorState(queryClient);
  }, [setRole, setEngineType, setScoped]);

  // Re-validate and refresh the role on mount if already authenticated
  useEffect(() => {
    if (!savedKey && !savedAccount) return;

    fetch(`${API_BASE_URL}/auth/validate`, {
      method: 'POST',
      credentials: 'include',
      headers: savedKey ? { 'X-API-Key': savedKey } : {},
    })
      .then(async res => {
        const decision = resolveStartupValidation(res.status, await res.json().catch(() => null));
        // Nothing cancels this request on logout. If the user has since signed out, or back in with
        // another key, the answer is about a key no longer in use: applying it would hand the new
        // session the old key's role, or log it out over the old key's 401.
        if (savedKey && sessionStorage.getItem('openwa_api_key') !== savedKey) return;
        if (!savedKey && sessionStorage.getItem('openwa_account') !== '1') return;
        if (decision.action === 'logout') {
          handleLogout();
        } else if (decision.action === 'role') {
          setRole(decision.role);
          setScoped(decision.scoped);
          if (decision.engineType) setEngineType(decision.engineType);
        }
      })
      .catch(() => {
        // Network failure (API unreachable): keep the cached role so a transient outage at
        // page load doesn't eject the user — an explicit 401/403 above still logs out.
      });
  }, [savedKey, savedAccount, setRole, setEngineType, setScoped, handleLogout]);

  const loadingFallback = (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
      <Loader2 className="animate-spin" size={32} />
    </div>
  );

  if (!isAuthenticated) {
    return (
      <Suspense fallback={loadingFallback}>
        <Login onLogin={handleLogin} />
      </Suspense>
    );
  }

  return (
    <ToastProvider>
      <TawkToChat />
      <BrowserRouter>
        <Suspense fallback={loadingFallback}>
          <Routes>
            <Route path="/" element={<Layout onLogout={handleLogout} userRole={role} />}>
              <Route index element={<Dashboard />} />
              <Route path="sessions" element={<Sessions />} />
              <Route path="chats" element={<Chats />} />
              <Route path="webhooks" element={<Webhooks />} />
              <Route path="templates" element={<Templates />} />
              {role === 'admin' && !scoped && <Route path="api-keys" element={<ApiKeys />} />}
              {role === 'admin' && <Route path="logs" element={<Logs />} />}
              <Route path="message-tester" element={<MessageTester />} />
              <Route path="billing" element={<Billing />} />
              {role === 'admin' && !scoped && <Route path="infrastructure" element={<Infrastructure />} />}
              {role === 'admin' && !scoped && <Route path="plugins" element={<Plugins />} />}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </Suspense>
      </BrowserRouter>
    </ToastProvider>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <RoleProvider>
          <AppContent />
        </RoleProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
