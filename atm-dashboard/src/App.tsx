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

function AuthWidget() {
  const [open, setOpen] = useState(false);
  const [secret, setSecret] = useState(() => sessionStorage.getItem('atm-deploy-secret') || '');
  const isAuthed = !!secret;

  const handleSave = (val: string) => {
    setSecret(val);
    sessionStorage.setItem('atm-deploy-secret', val);
  };

  const handleClear = () => {
    setSecret('');
    sessionStorage.removeItem('atm-deploy-secret');
    setOpen(false);
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium transition-colors ${
          isAuthed
            ? 'bg-green-900/30 text-green-400 border border-green-500/20 hover:bg-green-900/50'
            : 'bg-yellow-900/30 text-yellow-400 border border-yellow-500/20 hover:bg-yellow-900/50'
        }`}
        title={isAuthed ? 'Authenticated' : 'Click to authenticate'}
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          {isAuthed ? (
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />
          ) : (
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          )}
        </svg>
        {isAuthed ? 'Authenticated' : 'Locked'}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-2 w-72 rounded-lg border border-gray-700 bg-gray-900 p-3 shadow-xl z-50">
          <label className="block text-xs text-gray-400 mb-1">Deploy Secret</label>
          <input
            type="password"
            value={secret}
            onChange={(e) => handleSave(e.target.value)}
            placeholder="X-Deploy-Secret"
            className="w-full rounded-md border border-gray-700 bg-gray-800 px-2 py-1.5 text-xs text-gray-200 placeholder-gray-600 focus:border-blue-500 focus:outline-none"
            autoFocus
          />
          <div className="mt-2 flex items-center justify-between">
            <span className={`text-xs ${isAuthed ? 'text-green-400' : 'text-gray-500'}`}>
              {isAuthed ? 'Secret saved to session' : 'Enter deploy secret'}
            </span>
            {isAuthed && (
              <button onClick={handleClear} className="text-xs text-red-400 hover:text-red-300">
                Clear
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
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
            <div className="flex items-center gap-4">
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
              <AuthWidget />
            </div>
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
