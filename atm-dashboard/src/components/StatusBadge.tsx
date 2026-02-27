
interface StatusBadgeProps {
  status: string;
  size?: 'sm' | 'md';
}

const colorMap: Record<string, { bg: string; text: string; dot: string }> = {
  // Green states
  ok: { bg: 'bg-green-500/10', text: 'text-green-400', dot: 'bg-green-400' },
  completed: { bg: 'bg-green-500/10', text: 'text-green-400', dot: 'bg-green-400' },
  running: { bg: 'bg-green-500/10', text: 'text-green-400', dot: 'bg-green-400' },
  connected: { bg: 'bg-green-500/10', text: 'text-green-400', dot: 'bg-green-400' },
  healthy: { bg: 'bg-green-500/10', text: 'text-green-400', dot: 'bg-green-400' },
  available: { bg: 'bg-green-500/10', text: 'text-green-400', dot: 'bg-green-400' },
  true: { bg: 'bg-green-500/10', text: 'text-green-400', dot: 'bg-green-400' },
  yes: { bg: 'bg-green-500/10', text: 'text-green-400', dot: 'bg-green-400' },
  idle: { bg: 'bg-green-500/10', text: 'text-green-400', dot: 'bg-green-400' },
  ready: { bg: 'bg-green-500/10', text: 'text-green-400', dot: 'bg-green-400' },

  // Cyan states (active work)
  active: { bg: 'bg-cyan-500/10', text: 'text-cyan-400', dot: 'bg-cyan-400' },
  busy: { bg: 'bg-cyan-500/10', text: 'text-cyan-400', dot: 'bg-cyan-400' },
  processing: { bg: 'bg-cyan-500/10', text: 'text-cyan-400', dot: 'bg-cyan-400' },

  // Yellow states
  deploying: { bg: 'bg-yellow-500/10', text: 'text-yellow-400', dot: 'bg-yellow-400' },
  in_progress: { bg: 'bg-yellow-500/10', text: 'text-yellow-400', dot: 'bg-yellow-400' },
  paused: { bg: 'bg-yellow-500/10', text: 'text-yellow-400', dot: 'bg-yellow-400' },
  locked: { bg: 'bg-yellow-500/10', text: 'text-yellow-400', dot: 'bg-yellow-400' },
  stopping: { bg: 'bg-yellow-500/10', text: 'text-yellow-400', dot: 'bg-yellow-400' },
  pending: { bg: 'bg-yellow-500/10', text: 'text-yellow-400', dot: 'bg-yellow-400' },
  waking: { bg: 'bg-yellow-500/10', text: 'text-yellow-400', dot: 'bg-yellow-400' },

  // Gray states
  stopped: { bg: 'bg-gray-500/10', text: 'text-gray-400', dot: 'bg-gray-400' },
  terminated: { bg: 'bg-gray-500/10', text: 'text-gray-400', dot: 'bg-gray-400' },
  shutting_down: { bg: 'bg-yellow-500/10', text: 'text-yellow-400', dot: 'bg-yellow-400' },

  // Red states
  failed: { bg: 'bg-red-500/10', text: 'text-red-400', dot: 'bg-red-400' },
  error: { bg: 'bg-red-500/10', text: 'text-red-400', dot: 'bg-red-400' },
  degraded: { bg: 'bg-red-500/10', text: 'text-red-400', dot: 'bg-red-400' },
  exited: { bg: 'bg-red-500/10', text: 'text-red-400', dot: 'bg-red-400' },
  disconnected: { bg: 'bg-red-500/10', text: 'text-red-400', dot: 'bg-red-400' },
  false: { bg: 'bg-red-500/10', text: 'text-red-400', dot: 'bg-red-400' },
  no: { bg: 'bg-red-500/10', text: 'text-red-400', dot: 'bg-red-400' },
  unavailable: { bg: 'bg-red-500/10', text: 'text-red-400', dot: 'bg-red-400' },

  // Blue states
  rolled_back: { bg: 'bg-blue-500/10', text: 'text-blue-400', dot: 'bg-blue-400' },
  rollback: { bg: 'bg-blue-500/10', text: 'text-blue-400', dot: 'bg-blue-400' },
};

const defaultColor = { bg: 'bg-gray-500/10', text: 'text-gray-400', dot: 'bg-gray-400' };

export default function StatusBadge({ status, size = 'sm' }: StatusBadgeProps) {
  const normalized = status?.toLowerCase().replace(/[\s-]+/g, '_') ?? 'unknown';
  const colors = colorMap[normalized] ?? defaultColor;
  const isSmall = size === 'sm';

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full font-medium ${colors.bg} ${colors.text} ${
        isSmall ? 'px-2.5 py-0.5 text-xs' : 'px-3 py-1 text-sm'
      }`}
    >
      <span className={`inline-block rounded-full ${colors.dot} ${isSmall ? 'h-1.5 w-1.5' : 'h-2 w-2'}`} />
      {status}
    </span>
  );
}
