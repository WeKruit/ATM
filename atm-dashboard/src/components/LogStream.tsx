import { useEffect, useRef, useState } from 'react';

interface LogStreamProps {
  url: string;
  active: boolean;
  onComplete?: (success: boolean) => void;
}

export default function LogStream({ url, active, onComplete }: LogStreamProps) {
  const [lines, setLines] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [result, setResult] = useState<{ success: boolean } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!active) {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      return;
    }

    setLines([]);
    setResult(null);

    const es = new EventSource(url);
    eventSourceRef.current = es;

    es.onopen = () => setConnected(true);

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'log' && data.line) {
          setLines((prev) => [...prev, data.line]);
        } else if (data.type === 'complete') {
          setResult({ success: data.success });
          onComplete?.(data.success);
          es.close();
          setConnected(false);
        }
      } catch {
        setLines((prev) => [...prev, event.data]);
      }
    };

    es.onerror = () => {
      setConnected(false);
      es.close();
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [url, active, onComplete]);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [lines]);

  return (
    <div className="rounded-lg border border-gray-700 overflow-hidden">
      {/* Terminal header */}
      <div className="flex items-center justify-between bg-gray-800 px-4 py-2 border-b border-gray-700">
        <div className="flex items-center gap-2">
          <div className="flex gap-1.5">
            <div className="h-3 w-3 rounded-full bg-red-500/80" />
            <div className="h-3 w-3 rounded-full bg-yellow-500/80" />
            <div className="h-3 w-3 rounded-full bg-green-500/80" />
          </div>
          <span className="ml-2 text-xs text-gray-400 font-mono">deploy stream</span>
        </div>
        <span className={`text-xs font-medium ${connected ? 'text-green-400' : 'text-gray-500'}`}>
          {connected ? 'Connected' : 'Disconnected'}
        </span>
      </div>

      {/* Terminal body */}
      <div
        ref={containerRef}
        className="bg-gray-950 p-4 font-mono text-sm leading-relaxed overflow-y-auto max-h-96 min-h-[12rem]"
      >
        {lines.length === 0 && !connected && !result && (
          <span className="text-gray-600">Waiting for connection...</span>
        )}
        {lines.map((line, i) => (
          <div key={i} className="text-green-400/90 whitespace-pre-wrap break-all">
            <span className="text-gray-600 select-none mr-2">{String(i + 1).padStart(3, ' ')}</span>
            {line}
          </div>
        ))}
      </div>

      {/* Result banner */}
      {result && (
        <div
          className={`px-4 py-3 text-sm font-medium border-t ${
            result.success
              ? 'bg-green-500/10 text-green-400 border-green-500/20'
              : 'bg-red-500/10 text-red-400 border-red-500/20'
          }`}
        >
          {result.success ? 'Deploy completed successfully' : 'Deploy failed'}
        </div>
      )}
    </div>
  );
}
