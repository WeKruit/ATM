import React, { createContext, useContext, useEffect, useState } from 'react';
import type { Server, FleetConfig } from '../api';

interface FleetContextValue {
  servers: Server[];
  activeServer: Server | null;
  setActiveServer: (id: string) => void;
  loading: boolean;
}

const FleetContext = createContext<FleetContextValue>({
  servers: [],
  activeServer: null,
  setActiveServer: () => {},
  loading: true,
});

export function useFleet() {
  return useContext(FleetContext);
}

export function FleetProvider({ children }: { children: React.ReactNode }) {
  const [servers, setServers] = useState<Server[]>([]);
  const [activeId, setActiveId] = useState<string>(() => localStorage.getItem('atm-active-server') || '');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/fleet')
      .then((r) => r.json())
      .then((data: FleetConfig) => {
        setServers(data.servers);
        if (!activeId && data.servers.length > 0) {
          setActiveId(data.servers[0].id);
        }
      })
      .catch(() => setServers([]))
      .finally(() => setLoading(false));
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  const activeServer = servers.find((s) => s.id === activeId) || null;

  const setActiveServer = (id: string) => {
    setActiveId(id);
    localStorage.setItem('atm-active-server', id);
  };

  return (
    <FleetContext.Provider value={{ servers, activeServer, setActiveServer, loading }}>
      {children}
    </FleetContext.Provider>
  );
}
