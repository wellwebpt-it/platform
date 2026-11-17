import { Clock3 } from 'lucide-react';
import { formatAvailabilitySummary, type AvailabilitySummary } from '../lib/featuredProfessionals';

export function AvailabilityBadge({ summary, className = '' }: { summary?: AvailabilitySummary; className?: string }) {
  const label = formatAvailabilitySummary(summary);
  if (!label) return null;
  return <span className={`availability-badge ${className}`.trim()}><Clock3 size={13} aria-hidden="true"/>{label}</span>;
}
