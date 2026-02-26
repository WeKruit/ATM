import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { FleetProvider, useFleet } from './context/FleetContext';
import FleetOverviewPage from './pages/FleetOverviewPage';
import OverviewPage from './pages/OverviewPage';
import DeploysPage from './pages/DeploysPage';
import FleetPage from './pages/FleetPage';
import MetricsPage from './pages/MetricsPage';
import SecretsPage from './pages/SecretsPage';
import KamalPage from './pages/KamalPage';

type Tab = 'fleet' | 'overview' | 'deploys' | 'containers' | 'metrics' | 'secrets' | 'kamal';

const ALL_TABS: Tab[] = ['fleet', 'overview', 'deploys', 'containers', 'metrics', 'secrets', 'kamal'];
const isValidTab = (t: string): t is Tab => ALL_TABS.includes(t as Tab);

/** Tabs scoped to a specific machine */
const machineTabs: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'containers', label: 'Containers' },
  { id: 'deploys', label: 'Deploys' },
  { id: 'metrics', label: 'Metrics' },
];

/** Global tabs (not scoped to a machine) */
const globalTabs: { id: Tab; label: string }[] = [
  { id: 'secrets', label: 'Secrets' },
  { id: 'kamal', label: 'Kamal' },
];

const isMachineTab = (tab: Tab): boolean => machineTabs.some((t) => t.id === tab);

/** Read initial state from URL search params */
function readUrlState(): { tab: Tab; machine: string | null } {
  const params = new URLSearchParams(window.location.search);
  const rawTab = params.get('tab');
  const tab: Tab = rawTab && isValidTab(rawTab) ? rawTab : 'fleet';
  const machine = params.get('machine') || null;
  return { tab, machine };
}

/** Write current state to URL without adding history entries */
function writeUrlState(tab: Tab, machineId: string | null): void {
  const params = new URLSearchParams();
  params.set('tab', tab);
  if (machineId && isMachineTab(tab)) {
    params.set('machine', machineId);
  }
  const newUrl = '?' + params.toString();
  if (window.location.search !== newUrl) {
    history.replaceState(null, '', newUrl);
  }
}

function AppContent() {
  const { servers, setActiveServer } = useFleet();

  // Initialize state from URL params
  const initial = useMemo(() => readUrlState(), []);
  const [activeTab, setActiveTab] = useState<Tab>(initial.tab);
  const [selectedMachineId, setSelectedMachineId] = useState<string | null>(initial.machine);

  const selectedMachine = useMemo(
    () => servers.find((s) => s.id === selectedMachineId) || null,
    [servers, selectedMachineId],
  );

  // On mount: if URL has ?machine=X, set it as active once servers load
  useEffect(() => {
    if (initial.machine && servers.length > 0 && servers.some((s) => s.id === initial.machine)) {
      setActiveServer(initial.machine);
    }
  }, [servers]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync URL whenever tab or machine changes
  useEffect(() => {
    writeUrlState(activeTab, selectedMachineId);
  }, [activeTab, selectedMachineId]);

  /** Fleet card click → navigate into that machine's overview */
  const handleSelectMachine = useCallback((id: string) => {
    setSelectedMachineId(id);
    setActiveServer(id);
    setActiveTab('overview');
  }, [setActiveServer]);

  /** Back to fleet */
  const handleBackToFleet = useCallback(() => {
    setSelectedMachineId(null);
    setActiveTab('fleet');
  }, []);

  const handleTabClick = useCallback((tab: Tab) => {
    if (tab === 'fleet') {
      handleBackToFleet();
    } else if (isMachineTab(tab) && !selectedMachine) {
      // If clicking a per-machine tab without a machine selected, pick the first server
      if (servers.length > 0) {
        handleSelectMachine(servers[0].id);
        setActiveTab(tab);
      }
    } else {
      setActiveTab(tab);
    }
  }, [selectedMachine, servers, handleSelectMachine, handleBackToFleet]);

  const pages: Record<Tab, React.ReactNode> = {
    fleet: <FleetOverviewPage onSelectServer={handleSelectMachine} />,
    overview: <OverviewPage />,
    deploys: <DeploysPage />,
    containers: <FleetPage />,
    metrics: <MetricsPage />,
    secrets: <SecretsPage />,
    kamal: <KamalPage />,
  };

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="border-b border-gray-800 bg-gray-900/60 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-14">
            <div className="flex items-center gap-3">
              <button onClick={handleBackToFleet} className="hover:opacity-80 transition-opacity">
                <span className="text-lg font-bold tracking-tight text-gray-100">ATM</span>
              </button>
              <span className="text-xs text-gray-500 font-medium">WeKruit Ops</span>
            </div>
            {/* Machine context badge */}
            {selectedMachine && isMachineTab(activeTab) && (
              <div className="flex items-center gap-2">
                <button
                  onClick={handleBackToFleet}
                  className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
                  title="Back to Fleet"
                >
                  Fleet /
                </button>
                <span className="text-sm font-medium text-gray-300">{selectedMachine.name}</span>
                <span className="text-xs font-mono text-gray-500">{selectedMachine.ip}</span>
                <span className="text-xs text-gray-600 bg-gray-800 px-1.5 py-0.5 rounded">{selectedMachine.role}</span>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Tab bar */}
      <nav className="border-b border-gray-800 bg-gray-950/80">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex gap-1 -mb-px overflow-x-auto items-center">
            {/* Fleet tab */}
            <button
              onClick={() => handleTabClick('fleet')}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                activeTab === 'fleet'
                  ? 'border-blue-500 text-blue-400'
                  : 'border-transparent text-gray-500 hover:text-gray-300 hover:border-gray-700'
              }`}
            >
              Fleet
            </button>

            {/* Separator */}
            <span className="text-gray-700 px-1">|</span>

            {/* Per-machine tabs */}
            {machineTabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => handleTabClick(tab.id)}
                className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                  activeTab === tab.id
                    ? 'border-blue-500 text-blue-400'
                    : selectedMachine
                      ? 'border-transparent text-gray-500 hover:text-gray-300 hover:border-gray-700'
                      : 'border-transparent text-gray-600 cursor-default'
                }`}
              >
                {tab.label}
              </button>
            ))}

            {/* Separator */}
            <span className="text-gray-700 px-1">|</span>

            {/* Global tabs */}
            {globalTabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => handleTabClick(tab.id)}
                className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                  activeTab === tab.id
                    ? 'border-blue-500 text-blue-400'
                    : 'border-transparent text-gray-500 hover:text-gray-300 hover:border-gray-700'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </nav>

      {/* Page content */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {pages[activeTab]}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <FleetProvider>
      <AppContent />
    </FleetProvider>
  );
}
