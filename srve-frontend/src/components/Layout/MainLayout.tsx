import { SourcePanel } from '../SourcePanel/SourcePanel';
import { LayerPanel } from '../LayerPanel/LayerPanel';
import { LayerSettings } from '../LayerSettings/LayerSettings';
import { PreviewPanel } from '../Preview/PreviewPanel';
import { Timeline } from '../Timeline/Timeline';

export function MainLayout() {
  return (
    <div className="h-full w-full bg-srve-bg text-gray-200 flex flex-col">
      <div className="flex-1 min-h-0 flex">
        <aside className="w-[400px] min-w-[400px] bg-srve-panel border-r border-white/10 flex flex-col min-h-0">
          <div className="h-[340px] shrink-0 border-b border-white/10">
            <SourcePanel />
          </div>
          <div className="flex-1 min-h-0 border-b border-white/10">
            <LayerPanel />
          </div>
          <div className="h-[260px] shrink-0">
            <LayerSettings />
          </div>
        </aside>

        <main className="flex-1 min-w-0 p-4">
          <PreviewPanel />
        </main>
      </div>

      <footer className="h-[200px] bg-srve-panel border-t border-white/10">
        <Timeline />
      </footer>
    </div>
  );
}
