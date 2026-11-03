import React, { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { CHANNEL_LABEL, compact, niceMax, type Bar } from "../lib/analytics";
import { formatKes } from "../lib/format";
import { colors } from "../theme";

// Plain Views only (no SVG dependency), so the APK needs nothing beyond what it already ships.
export const CHANNEL_COLOR: Record<string, string> = {
  local: colors.ink,
  shopify: colors.success,
  woocommerce: colors.amber,
};
export const channelColor = (k: string) => CHANNEL_COLOR[k] ?? "#8A8578";
const ORDER = ["local", "shopify", "woocommerce"];
const rank = (k: string) => (ORDER.indexOf(k) < 0 ? 99 : ORDER.indexOf(k));
const stackOrder = (keys: string[]) => [...keys].sort((a, b) => rank(a) - rank(b));

/** Stacked daily/weekly/monthly revenue bars. Tap a bar to read that period; the last one starts selected. */
export function TrendChart({ bars, height = 150 }: { bars: Bar[]; height?: number }) {
  const [sel, setSel] = useState(bars.length - 1);
  useEffect(() => setSel(bars.length - 1), [bars.length]);

  const maxCents = Math.max(...bars.map((b) => b.total), 0);
  if (bars.length === 0 || maxCents === 0) {
    return (
      <View style={[s.empty, { height }]}>
        <Text style={s.emptyText}>No sales in this period.</Text>
      </View>
    );
  }
  const top = niceMax(maxCents);
  const cur = bars[Math.min(sel, bars.length - 1)] as Bar;
  const gap = bars.length > 20 ? 1 : 3;
  const mid = bars[Math.floor(bars.length / 2)] as Bar;
  const first = bars[0] as Bar;
  const last = bars[bars.length - 1] as Bar;

  return (
    <View>
      <View style={s.tip}>
        <View style={{ flexShrink: 1 }}>
          <Text style={s.tipDate}>{cur.label}</Text>
          <View style={s.tipRow}>
            {stackOrder(Object.keys(cur.bySource).filter((k) => (cur.bySource[k] ?? 0) > 0)).map((k) => (
              <View key={k} style={s.tipChip}>
                <View style={[s.dot, { backgroundColor: channelColor(k) }]} />
                <Text style={s.tipChipText}>
                  {CHANNEL_LABEL[k] ?? k} {compact((cur.bySource[k] ?? 0) / 100)}
                </Text>
              </View>
            ))}
          </View>
        </View>
        <Text style={s.tipTotal}>{formatKes(cur.total)}</Text>
      </View>

      <View style={{ height, marginTop: 8 }}>
        {[0, 0.5, 1].map((f) => (
          <View key={f} style={[s.grid, { bottom: f * (height - 14) + 14 }]} />
        ))}
        <Text style={[s.axis, { top: 0, position: "absolute", left: 0 }]}>{compact(top / 100)}</Text>
        <View style={[s.bars, { gap, paddingTop: 14 }]}>
          {bars.map((b, i) => (
            <Pressable
              key={b.key}
              onPress={() => setSel(i)}
              accessibilityRole="button"
              accessibilityLabel={`${b.label}, ${formatKes(b.total)}`}
              style={[s.col, i === sel && s.colSel]}
            >
              {stackOrder(Object.keys(b.bySource)).map((k) => {
                const v = b.bySource[k] ?? 0;
                if (v <= 0) return null;
                const h = Math.max(2, Math.round((v / top) * (height - 14)));
                return <View key={k} style={{ height: h, backgroundColor: channelColor(k) }} />;
              })}
            </Pressable>
          ))}
        </View>
      </View>
      <View style={s.xAxis}>
        <Text style={s.axis}>{first.label}</Text>
        {bars.length > 6 ? <Text style={s.axis}>{mid.label}</Text> : null}
        <Text style={s.axis}>{last.label}</Text>
      </View>
    </View>
  );
}

/** One segmented bar showing how a total splits across channels. */
export function SplitBar({ items }: { items: { key: string; value: number }[] }) {
  return (
    <View style={s.split} accessibilityRole="image" accessibilityLabel="Revenue share by channel">
      {items.map((i) => (
        <View key={i.key} style={{ flex: i.value, minWidth: 6, backgroundColor: channelColor(i.key), borderRadius: 99 }} />
      ))}
    </View>
  );
}

/** Thin horizontal progress bar, 0..1. */
export function HBar({ pct, color = colors.amber }: { pct: number; color?: string }) {
  return (
    <View style={s.track}>
      <View style={{ width: `${Math.max(0, Math.min(1, pct)) * 100}%`, height: "100%", backgroundColor: color }} />
    </View>
  );
}

const s = StyleSheet.create({
  empty: { alignItems: "center", justifyContent: "center", backgroundColor: colors.paper, borderRadius: 10 },
  emptyText: { color: colors.muted, fontSize: 13 },
  tip: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 10 },
  tipDate: { fontSize: 12, color: colors.muted, fontWeight: "600" },
  tipTotal: { fontSize: 15, fontWeight: "700", color: colors.ink },
  tipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 },
  tipChip: { flexDirection: "row", alignItems: "center", gap: 4 },
  tipChipText: { fontSize: 11, color: colors.muted },
  dot: { width: 8, height: 8, borderRadius: 2 },
  grid: { position: "absolute", left: 0, right: 0, height: 1, backgroundColor: colors.lineSoft },
  bars: { flex: 1, flexDirection: "row", alignItems: "flex-end" },
  col: { flex: 1, height: "100%", justifyContent: "flex-end", borderRadius: 3, overflow: "hidden" },
  colSel: { backgroundColor: colors.amberSoft },
  xAxis: { flexDirection: "row", justifyContent: "space-between", marginTop: 6 },
  axis: { fontSize: 10, color: colors.muted, fontFamily: "monospace" },
  split: { flexDirection: "row", gap: 3, height: 8 },
  track: { height: 6, borderRadius: 99, backgroundColor: colors.lineSoft, overflow: "hidden" },
});
