// Daily revenue as a smooth area chart. Dependency-free (plain SVG), same idea
// as the stacked bar chart it replaces, but the hover tooltip still breaks the
// day down by channel so that detail isn't lost.
//
// `rows` is the /reports/trend payload: [{ day, source_type, revenue }] with
// revenue in cents. `labels` / `colors` map a source_type to its display name
// and a Tailwind background class (the same ones the channel split uses).
//
// Layout trick: the SVG is stretched over the box (preserveAspectRatio="none")
// and only draws shapes, with non-scaling strokes so lines stay crisp. Anything
// containing text or a circle (axis labels, hover dot, tooltip) is plain HTML
// positioned in percentages, so it never gets distorted by the stretch.
import { useMemo, useRef, useState } from 'react';

const W = 640;
const H = 200;
const PAD_T = 14;
const PAD_B = 2;

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const shortDate = (ts) => new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const longDate = (ts) => new Date(ts).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

// Round up to a "nice" axis maximum (1, 2, 2.5, 5 or 10 times a power of ten).
function niceMax(v) {
  if (v <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  const f = v / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * pow;
}

// Monotone cubic interpolation (Fritsch–Butland): a smooth curve that never
// overshoots between points, so a quiet day can't dip below zero.
function curvePath(pts) {
  const n = pts.length;
  if (n < 2) return '';
  const dx = [];
  const m = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1].x - pts[i].x;
    m[i] = (pts[i + 1].y - pts[i].y) / (dx[i] || 1);
  }
  const t = new Array(n);
  t[0] = m[0];
  t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) {
    t[i] = m[i - 1] * m[i] <= 0
      ? 0
      : (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / m[i - 1] + (dx[i] + 2 * dx[i - 1]) / m[i]);
  }
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += ` C${pts[i].x + h},${pts[i].y + t[i] * h} ${pts[i + 1].x - h},${pts[i + 1].y - t[i + 1] * h} ${pts[i + 1].x},${pts[i + 1].y}`;
  }
  return d;
}

export default function RevenueChart({ rows, labels = {}, colors = {} }) {
  const boxRef = useRef(null);
  const [hover, setHover] = useState(null);

  const chart = useMemo(() => {
    const byDay = {};
    for (const r of rows || []) {
      byDay[r.day] = byDay[r.day] || {};
      byDay[r.day][r.source_type] = (byDay[r.day][r.source_type] || 0) + r.revenue;
    }
    const days = Object.keys(byDay).sort();
    if (days.length === 0) return null;

    const data = days.map((day) => {
      const channels = byDay[day];
      const parsed = Date.parse(day);
      return { day, channels, total: Object.values(channels).reduce((a, b) => a + b, 0), ts: Number.isNaN(parsed) ? null : parsed };
    });
    // Place points by date when every day parses (gaps then show as gaps); otherwise evenly.
    const byDate = data.every((d) => d.ts !== null);
    const lo = byDate ? data[0].ts : 0;
    const hi = byDate ? data[data.length - 1].ts : data.length - 1;
    const yMax = niceMax(Math.max(...data.map((d) => d.total)));
    const plotH = H - PAD_T - PAD_B;
    const pts = data.map((d, i) => {
      const pos = byDate ? d.ts : i;
      return {
        ...d,
        x: hi === lo ? W / 2 : ((pos - lo) / (hi - lo)) * W,
        y: PAD_T + (1 - d.total / yMax) * plotH,
      };
    });
    const line = curvePath(pts);
    const area = line ? `${line} L${pts[pts.length - 1].x},${H} L${pts[0].x},${H} Z` : '';
    const grid = [0, 0.5, 1].map((f) => ({ y: PAD_T + (1 - f) * plotH, label: compact.format((yMax * f) / 100) }));
    return { pts, line, area, grid, first: data[0], last: data[data.length - 1] };
  }, [rows]);

  if (!chart) {
    return <div className="px-5 py-12 text-center text-text-muted text-sm">No sales in this period yet.</div>;
  }

  const { pts, line, area, grid, first, last } = chart;

  function onMove(e) {
    const rect = boxRef.current.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i].x - x) < Math.abs(pts[best].x - x)) best = i;
    setHover(best);
  }

  const active = hover !== null ? pts[hover] : pts.length === 1 ? pts[0] : null;
  const activePct = active ? { x: (active.x / W) * 100, y: (active.y / H) * 100 } : null;

  return (
    <div className="px-5 pt-4 pb-4">
      <div className="relative pl-10">
        <div
          ref={boxRef}
          className="relative h-48 touch-pan-y"
          onPointerMove={onMove}
          onPointerDown={onMove}
          onPointerLeave={() => setHover(null)}
          role="img"
          aria-label={`Daily revenue from ${shortDate(first.ts ?? 0)} to ${shortDate(last.ts ?? 0)}`}
        >
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 w-full h-full">
            <defs>
              <linearGradient id="revenue-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" style={{ stopColor: 'var(--color-accent)', stopOpacity: 0.4 }} />
                <stop offset="100%" style={{ stopColor: 'var(--color-accent)', stopOpacity: 0 }} />
              </linearGradient>
            </defs>
            {grid.map((g, i) => (
              <line
                key={i}
                x1="0" x2={W} y1={g.y} y2={g.y}
                vectorEffect="non-scaling-stroke"
                strokeDasharray={i === 0 ? undefined : '3 4'}
                style={{ stroke: 'var(--color-line)', strokeWidth: 1 }}
              />
            ))}
            {area && <path d={area} fill="url(#revenue-fill)" />}
            {line && (
              <path
                d={line} fill="none" vectorEffect="non-scaling-stroke"
                strokeLinejoin="round" strokeLinecap="round"
                style={{ stroke: 'var(--color-ink)', strokeWidth: 2 }}
              />
            )}
            {active && pts.length > 1 && (
              <line
                x1={active.x} x2={active.x} y1="0" y2={H}
                vectorEffect="non-scaling-stroke" strokeDasharray="3 4"
                style={{ stroke: 'var(--color-text-muted)', strokeWidth: 1 }}
              />
            )}
          </svg>

          {grid.map((g, i) => (
            <span
              key={i}
              className="absolute -left-10 w-8 -translate-y-1/2 text-right text-[10px] font-mono text-text-muted"
              style={{ top: `${(g.y / H) * 100}%` }}
            >
              {g.label}
            </span>
          ))}

          {active && (
            <>
              <span
                className="absolute w-3 h-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent border-2 border-ink pointer-events-none"
                style={{ left: `${activePct.x}%`, top: `${activePct.y}%` }}
              />
              <div
                className="absolute z-10 -translate-x-1/2 -translate-y-full bg-ink text-white rounded-lg px-3 py-2 text-xs shadow-lg pointer-events-none whitespace-nowrap"
                style={{ left: `${Math.min(86, Math.max(14, activePct.x))}%`, top: `calc(${activePct.y}% - 12px)` }}
              >
                <div className="font-mono text-[10px] text-white/60">{active.ts !== null ? longDate(active.ts) : active.day}</div>
                <div className="font-display font-700 text-sm tabular-nums">KES {Math.round(active.total / 100).toLocaleString()}</div>
                {Object.keys(active.channels).length > 1 && (
                  <div className="mt-1 space-y-0.5">
                    {Object.entries(active.channels).map(([ch, rev]) => (
                      <div key={ch} className="flex items-center justify-between gap-4 text-white/80">
                        <span className="flex items-center gap-1.5">
                          <span className={`w-2 h-2 rounded-sm ring-1 ring-white/50 ${colors[ch] || 'bg-ink'}`} />
                          {labels[ch] || ch}
                        </span>
                        <span className="font-mono tabular-nums">{Math.round(rev / 100).toLocaleString()}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
      <div className="flex justify-between text-[10px] text-text-muted mt-2 pl-10 font-mono">
        <span>{first.ts !== null ? shortDate(first.ts) : first.day}</span>
        <span>{last.ts !== null ? shortDate(last.ts) : last.day}</span>
      </div>
    </div>
  );
}
