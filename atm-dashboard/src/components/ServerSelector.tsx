import { useState, useEffect } from 'react';
import { useFleet } from '../context/FleetContext';

export default function ServerSelector() {
  const { servers, activeServer, setActiveServer } = useFleet();
  const [health, setHealth] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const checkHealth = async () => {
      const results: Record<string, boolean> = {};
      for (const s of servers) {
        try {
          const res = await fetch(`${s.host}/health`, { signal: AbortSignal.timeout(3000) });
          results[s.id] = res.ok;
        } catch {
          results[s.id] = false;
        }
      }
      setHealth(results);
    };
    checkHealth();
    const interval = setInterval(checkHealth, 30000);
    return () => clearInterval(interval);
  }, [servers]);

  if (servers.length <= 1) {
    const s = servers[0];
    if (!s) return null;
    return (
      <div className="flex items-center gap-2 text-sm text-gray-400">
        <span className={`h-2 w-2 rounded-full ${health[s.id] ? 'bg-green-400' : 'bg-red-400'}`} />
        <span className="font-medium">{s.name}</span>
        <span className="text-xs text-gray-600">{s.environment}</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <select
        value={activeServer?.id || ''}
        onChange={(e) => setActiveServer(e.target.value)}
        className="bg-gray-800 border border-gray-700 text-gray-300 text-sm rounded-lg px-3 py-1.5 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
      >
        {servers.map((s) => (
          <option key={s.id} value={s.id}>
            {health[s.id] === false ? '\u26A0 ' : '\u2713 '}{s.name} ({s.environment})
          </option>
        ))}
      </select>
    </div>
  );
}
