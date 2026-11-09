import useConnectionState from '../hooks/useConnectionState';

// Small coloured dot for the navigation: green when the API answers, amber while
// sales rung up offline are waiting to be sent, red when the app can't reach the server.
// `withLabel` adds the words next to it (used in the status line and the phone More panel).
export default function ConnectionDot({ withLabel = false, className = '' }) {
  const { tone, label, short } = useConnectionState();
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`} role="status" title={label}>
      <span className={`w-2 h-2 rounded-full shrink-0 ${tone}`} aria-hidden="true" />
      {withLabel ? <span>{short}</span> : <span className="sr-only">{label}</span>}
    </span>
  );
}
