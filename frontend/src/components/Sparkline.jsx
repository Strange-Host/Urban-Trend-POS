// A tiny trend line with no axes: the shape of the last few weeks at a glance, sitting next to a number.
// Purely decorative (the number beside it carries the meaning), so it is hidden from screen readers.
export default function Sparkline({ values, className = '' }) {
  if (!values || values.length < 2) return null;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const W = 100;
  const H = 28;
  const pad = 2;
  const pts = values.map((v, i) => [
    (i / (values.length - 1)) * W,
    H - pad - ((v - min) / span) * (H - pad * 2),
  ]);
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `0,${H} ${line} ${W},${H}`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={className} aria-hidden="true" data-testid="sparkline">
      <polygon points={area} fill="var(--color-accent)" opacity="0.18" />
      <polyline points={line} fill="none" stroke="var(--color-accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
