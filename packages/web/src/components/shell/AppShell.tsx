import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { PeekPanel } from './PeekPanel';
import { CommandPalette } from '../palette/CommandPalette';
import { QuickCreate } from '../items/QuickCreate';
import { HelpDialog } from './HelpDialog';
import { useGlobalShortcuts } from './useGlobalShortcuts';
import { RejectedMutationToaster } from './RejectedMutationToaster';
import { BulkBar } from '../views/BulkBar';

export function AppShell() {
  useGlobalShortcuts();
  return (
    <div className="flex h-full overflow-hidden">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <div className="flex min-h-0 flex-1">
          <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
            <Outlet />
            <BulkBar />
          </main>
          <PeekPanel />
        </div>
      </div>
      <CommandPalette />
      <QuickCreate />
      <HelpDialog />
      <RejectedMutationToaster />
    </div>
  );
}
