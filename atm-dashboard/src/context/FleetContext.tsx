import React, { createContext, useContext, useEffect, useState } from 'react';
import type { Server, FleetConfig } from '../api';

interface FleetContextValue {
  servers: Server[];
  activeServer: Server | null;
  setActiveServer: (id: string) => void;
  selectedEnvironment: string;
  setSelectedEnvironment: (environment: string) => void;
  includeTerminated: boolean;
  setIncludeTerminated: (include: boolean) => void;
  currentEnvironment: string;
  loading: boolean;
}

const FleetContext = createContext<FleetContextValue>({
  servers: [],
  activeServer: null,
  setActiveServer: () => {},
  selectedEnvironment: 'current',
  setSelectedEnvironment: () => {},
  includeTerminated: false,
  setIncludeTerminated: () => {},
  currentEnvironment: 'staging',
  loading: true,
});

export function useFleet() {
  return useContext(FleetContext);
}

export function FleetProvider({ children }: { children: React.ReactNode }) {
  const [servers, setServers] = useState<Server[]>([]);
  const [activeId, setActiveId] = useState<string>(() => localStorage.getItem('atm-active-server') || '');
  const [selectedEnvironment, setSelectedEnvironment] = useState<string>(
    () => localStorage.getItem('atm-fleet-environment') || 'current',
  );
  const [includeTerminated, setIncludeTerminated] = useState<boolean>(
    () => localStorage.getItem('atm-fleet-include-terminated') === 'true',
  );
  const [currentEnvironment, setCurrentEnvironment] = useState<string>('staging');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const params = new URLSearchParams();
    if (selectedEnvironment && selectedEnvironment !== 'current') {
      params.set('environment', selectedEnvironment);
    }
    params.set('includeTerminated', includeTerminated ? 'true' : 'false');
    const query = params.toString();

    fetch(`/fleet${query ? `?${query}` : ''}`)
      .then((r) => r.json())
      .then((data: FleetConfig) => {
        setServers(data.servers);
        if (data.filter?.currentEnvironment) {
          setCurrentEnvironment(data.filter.currentEnvironment);
        }

        const hasActive = data.servers.some((s) => s.id === activeId);
        if (!hasActive && data.servers.length > 0) {
          const nextId = data.servers[0].id;
          if (nextId) {
            setActiveId(nextId);
            localStorage.setItem('atm-active-server', nextId);
          }
        }
      })
      .catch(() => setServers([]))
      .finally(() => setLoading(false));
  }, [activeId, selectedEnvironment, includeTerminated]);

  const activeServer = servers.find((s) => s.id === activeId) || null;

  const setActiveServer = (id: string) => {
    setActiveId(id);
    localStorage.setItem('atm-active-server', id);
  };

  const handleSetEnvironment = (environment: string) => {
    setSelectedEnvironment(environment);
    localStorage.setItem('atm-fleet-environment', environment);
  };

  const handleSetIncludeTerminated = (include: boolean) => {
    setIncludeTerminated(include);
    localStorage.setItem('atm-fleet-include-terminated', include ? 'true' : 'false');
  };

  return (
    <FleetContext.Provider
      value={{
        servers,
        activeServer,
        setActiveServer,
        selectedEnvironment,
        setSelectedEnvironment: handleSetEnvironment,
        includeTerminated,
        setIncludeTerminated: handleSetIncludeTerminated,
        currentEnvironment,
        loading,
      }}
    >
      {children}
    </FleetContext.Provider>
  );
}
