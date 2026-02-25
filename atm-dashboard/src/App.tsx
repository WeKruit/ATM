import React, { useState } from 'react';
import OverviewPage from './pages/OverviewPage';
import DeploysPage from './pages/DeploysPage';
import FleetPage from './pages/FleetPage';
import MetricsPage from './pages/MetricsPage';
import SecretsPage from './pages/SecretsPage';
import KamalPage from './pages/KamalPage';

type Tab = 'overview' | 'deploys' | 'fleet' | 'metrics' | 'secrets' | 'kamal';

const tabs: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'deploys', label: 'Deploys' },
  { id: 'fleet', label: 'Fleet' },
  { id: 'metrics', label: 'Metrics' },
  { id: 'secrets', label: 'Secrets' },
  { id: 'kamal', label: 'Kamal' },
];

const pages: Record<Tab, React.FC> = {
  overview: OverviewPage,
  deploys: DeploysPage,
  fleet: FleetPage,
  metrics: MetricsPage,
  secrets: SecretsPage,
  kamal: KamalPage,
};

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const Page = pages[activeTab];

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="border-b border-gray-800 bg-gray-900/60 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-14">
            <div className="flex items-center gap-3">
              <span className="text-lg font-bold tracking-tight text-gray-100">ATM</span>
              <span className="text-xs text-gray-500 font-medium">WeKruit Ops</span>
            </div>
            <span className="text-xs text-gray-600 font-mono">v1.0.0</span>
          </div>
        </div>
      </header>

      {/* Tab bar */}
      <nav className="border-b border-gray-800 bg-gray-950/80">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex gap-1 -mb-px overflow-x-auto">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
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
        <Page />
      </main>
    </div>
  );
}
