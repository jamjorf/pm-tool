import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { SessionProvider, useSession } from './session';
import { StoreProvider } from './store/provider';
import { UIStateProvider } from './state';
import { ToastProvider } from './lib/toast';
import { AppShell } from './components/shell/AppShell';
import { LoginPage } from './pages/LoginPage';
import { MyWorkPage } from './pages/MyWorkPage';
import { ViewPage, NewViewPage } from './pages/ViewPage';
import { ItemPage } from './pages/ItemPage';
import { InboxPage } from './pages/InboxPage';
import { SearchPage } from './pages/SearchPage';
import { SettingsPage } from './pages/SettingsPage';
import { ProjectRedirect, ProjectsPage, NewProjectPage, ProjectSettingsPage } from './pages/ProjectPages';
import { WorkflowsPage } from './pages/admin/WorkflowsPage';
import { TypesPage } from './pages/admin/TypesPage';
import { WebhooksPage, IntegrationsPage, UsersPage } from './pages/admin/AdminPages';
import { useIsFirmAdmin } from './store/hooks';

function RequireSession() {
  const { me, loading, rep } = useSession();
  const loc = useLocation();
  if (loading) return <div className="flex h-full items-center justify-center text-sm text-fg-muted">Starting…</div>;
  if (!me) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  if (!rep) return <div className="flex h-full items-center justify-center text-sm text-fg-muted">Opening local store…</div>;
  return (
    <StoreProvider>
      <UIStateProvider>
        <AppShell />
      </UIStateProvider>
    </StoreProvider>
  );
}

function RequireAdmin() {
  const isAdmin = useIsFirmAdmin();
  if (!isAdmin) return <div className="p-8 text-sm text-fg-muted">Firm admins only.</div>;
  return <Outlet />;
}

export function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <SessionProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route element={<RequireSession />}>
              <Route index element={<MyWorkPage />} />
              <Route path="/p/:projectKey" element={<ProjectRedirect />} />
              <Route path="/p/:projectKey/new-view" element={<NewViewPage />} />
              <Route path="/p/:projectKey/settings" element={<ProjectSettingsPage />} />
              <Route path="/p/:projectKey/v/:viewId" element={<ViewPage />} />
              <Route path="/v/:viewId" element={<ViewPage />} />
              <Route path="/views/new" element={<NewViewPage />} />
              <Route path="/i/:itemKey" element={<ItemPage />} />
              <Route path="/inbox" element={<InboxPage />} />
              <Route path="/search" element={<SearchPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/projects" element={<ProjectsPage />} />
              <Route path="/projects/new" element={<NewProjectPage />} />
              <Route path="/admin" element={<RequireAdmin />}>
                <Route index element={<Navigate to="/admin/workflows" replace />} />
                <Route path="workflows" element={<WorkflowsPage />} />
                <Route path="types" element={<TypesPage />} />
                <Route path="webhooks" element={<WebhooksPage />} />
                <Route path="integrations" element={<IntegrationsPage />} />
                <Route path="users" element={<UsersPage />} />
              </Route>
              <Route path="*" element={<div className="p-8 text-sm text-fg-muted">Not found.</div>} />
            </Route>
          </Routes>
        </SessionProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}
