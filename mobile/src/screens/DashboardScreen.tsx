import { useNavigation } from "@react-navigation/native";
import React, { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { api } from "../api";
import type { Analytics, AnalyticsRange } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { HBar, SplitBar, TrendChart, channelColor } from "../components/charts";
import { Header } from "../components/Header";
import { Banner, Card, Empty, Pill, row, text } from "../components/ui";
import {
  CHANNEL_LABEL,
  RANGES,
  buildBars,
  channelTotals,
  compact,
  deltaPct,
  greeting,
  humanize,
} from "../lib/analytics";
import { formatAmount, formatKes, timeAgo } from "../lib/format";
import { can } from "../lib/permissions";
import { useRemote } from "../lib/useRemote";
import { MIN_TOUCH, colors, radius } from "../theme";

const periodLabel = (r: AnalyticsRange) => (r === "all" ? "All time" : `Last ${r} days`);

export default function DashboardScreen() {
  const { user, offline } = useAuth();
  const [range, setRange] = useState<AnalyticsRange>("30");
  const allowed = can(user, "reports.view");

  const today = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  const firstName = user?.name?.trim().split(/\s+/)[0];

  if (!allowed) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.paper }}>
        <Header eyebrow={today} title="Dashboard" />
        <Empty title="Reports are not on your account" note="Ask the owner to give you the reports permission." />
      </View>
    );
  }

  return <DashboardBody range={range} setRange={setRange} today={today} firstName={firstName} offline={offline} />;
}

function DashboardBody({
  range,
  setRange,
  today,
  firstName,
  offline,
}: {
  range: AnalyticsRange;
  setRange: (r: AnalyticsRange) => void;
  today: string;
  firstName?: string;
  offline: boolean;
}) {
  const nav = useNavigation<any>();
  const { data, savedAt, loading, refreshing, error, refresh } = useRemote<Analytics>(`analytics:${range}`, (t) =>
    api.analytics(t, range),
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.paper }}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.ink} colors={[colors.amber]} />}
      >
        <Header
          eyebrow={today}
          title={firstName ? `${greeting()}, ${firstName}` : "Dashboard"}
          right={savedAt ? <Pill text={`Updated ${timeAgo(savedAt)}`} /> : undefined}
        />
        <Text style={s.lede}>Every channel in one place: the shop register plus connected Shopify and WooCommerce stores.</Text>

        <RangeToggle value={range} onChange={setRange} />

        {offline ? <Banner text="Offline · showing saved figures." /> : error ? <Banner text={error} /> : null}

        {loading && !data ? <ActivityIndicator style={{ marginTop: 40 }} color={colors.ink} /> : null}

        {data ? (
          <>
            {data.overview ? <TodayCard o={data.overview} /> : null}
            <AlertGrid data={data} nav={nav} />
            <Kpis data={data} />
            <TrendCard data={data} range={range} />
            <PaymentCard data={data} />
            <ChannelCard data={data} />
            <PipelineCard data={data} />
            <TopProductsCard data={data} />
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

// ---------- controls
function RangeToggle({ value, onChange }: { value: AnalyticsRange; onChange: (r: AnalyticsRange) => void }) {
  return (
    <View style={s.range} accessibilityRole="tablist">
      {RANGES.map((r) => {
        const on = r.key === value;
        return (
          <Pressable
            key={r.key}
            onPress={() => onChange(r.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            style={[s.rangeBtn, on && s.rangeBtnOn]}
          >
            <Text style={[s.rangeText, on && s.rangeTextOn]}>{r.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** "KES" small, amount large: saves width in a half-width tile. */
function Money({ cents, style }: { cents: number; style?: object }) {
  return (
    <Text style={[s.big, style]} numberOfLines={1} adjustsFontSizeToFit>
      <Text style={s.kes}>KES </Text>
      {formatAmount(cents)}
    </Text>
  );
}

function Delta({ now, before, range }: { now: number; before: number | null | undefined; range: AnalyticsRange }) {
  const d = deltaPct(now, before);
  if (d === null || range === "all") return null;
  const up = d >= 0;
  return (
    <View style={[s.delta, { backgroundColor: up ? colors.successSoft : colors.redSoft }]}>
      <Text style={[s.deltaText, { color: up ? colors.success : colors.redText }]}>
        {up ? "▲" : "▼"} {Math.abs(d).toFixed(1)}% vs previous {range} days
      </Text>
    </View>
  );
}

// ---------- today
function TodayCard({ o }: { o: NonNullable<Analytics["overview"]> }) {
  return (
    <View style={s.today}>
      <Text style={[text.mono, { color: colors.amber }]}>Today so far</Text>
      <Text style={s.todayBig}>
        <Text style={s.todayKes}>KES </Text>
        {formatAmount(o.combinedRevenueCents)}
      </Text>
      <View style={s.todayRow}>
        <TodayStat label="Shop" value={formatKes(o.posRevenueCents)} sub={`${o.posTransactions} sales`} />
        <TodayStat label="Online" value={formatKes(o.onlineRevenueCents)} sub={`${o.onlineOrders} orders`} />
        <TodayStat label="Cash in" value={formatKes(o.cashCollectedCents)} sub="all channels" />
      </View>
    </View>
  );
}
function TodayStat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <View style={{ flex: 1 }}>
      <Text style={s.todayLabel}>{label}</Text>
      <Text style={s.todayVal} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      <Text style={s.todayLabel}>{sub}</Text>
    </View>
  );
}

// ---------- alerts
interface Tile {
  key: string;
  label: string;
  count: number;
  detail: string;
  clear: string;
  onPress: () => void;
}

function AlertGrid({ data, nav }: { data: Analytics; nav: any }) {
  const tiles = useMemo<Tile[]>(() => {
    const t: Tile[] = [];
    const ov = data.overview;
    const al = data.stockAlerts;
    const toStock = () => nav.navigate("Stock");
    if (ov) {
      t.push({
        key: "low",
        label: "Low stock",
        count: ov.lowStockCount,
        detail: "Products at or below their reorder level",
        clear: "Every product is above its reorder level",
        onPress: toStock,
      });
      const count = ov.unpaidParcels.reduce((a, c) => a + c.count, 0);
      const owed = ov.unpaidParcels.reduce((a, c) => a + c.owedCents, 0);
      t.push({
        key: "unpaid",
        label: "Unpaid parcels",
        count,
        detail: `${formatKes(owed)} still owed on dispatched parcels`,
        clear: "No dispatched parcel is waiting on payment",
        onPress: () => nav.navigate("Orders", { unpaid: true, nonce: Date.now() }),
      });
    }
    if (al) {
      t.push(
        { key: "exp", label: "Expiring soon", count: al.expiring, detail: `Batches expiring within ${al.expiryAlertDays} days`, clear: "No batch is close to expiry", onPress: toStock },
        { key: "expd", label: "Expired in stock", count: al.expired, detail: "Expired batches still on a shelf", clear: "No expired stock on the shelves", onPress: toStock },
        { key: "rec", label: "Recalled batches", count: al.recalled, detail: "Recalled and taken off sale", clear: "No batch has been recalled", onPress: toStock },
        { key: "dmg", label: "Damaged (30 days)", count: al.damaged, detail: al.damagedDetail, clear: "No damaged stock in 30 days", onPress: toStock },
      );
    }
    return t;
  }, [data, nav]);

  if (tiles.length === 0) return null;
  return (
    <View style={s.grid}>
      {tiles.map((t) => {
        const hot = t.count > 0;
        return (
          <Pressable
            key={t.key}
            onPress={t.onPress}
            accessibilityRole="button"
            style={({ pressed }) => [s.tile, hot && { borderColor: colors.amber }, pressed && { opacity: 0.7 }]}
          >
            <Text style={s.tileLabel}>{t.label}</Text>
            <Text style={[s.tileCount, { color: hot ? colors.amber : colors.success }]}>{t.count}</Text>
            <Text style={s.tileDetail} numberOfLines={3}>
              {hot ? t.detail : t.clear}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ---------- headline numbers
function Kpis({ data }: { data: Analytics }) {
  const local = data.channels.filter((c) => c.sourceType === "local").reduce((a, c) => a + c.revenueCents, 0);
  const online = data.channels.filter((c) => c.sourceType !== "local").reduce((a, c) => a + c.revenueCents, 0);
  const items: { label: string; node: React.ReactNode; sub?: string }[] = [
    { label: "Revenue", node: <Money cents={data.summary.revenueCents} />, sub: `${data.summary.transactions} transactions` },
    { label: "Average basket", node: <Money cents={data.summary.avgBasketCents} />, sub: "per transaction" },
    { label: "Local store", node: <Money cents={local} /> },
    { label: "Online channels", node: <Money cents={online} /> },
  ];
  if (data.inventoryRetailValueCents !== null) {
    items.push({ label: "Inventory value", node: <Money cents={data.inventoryRetailValueCents} />, sub: "at retail price" });
  }
  if (data.overview) {
    items.push({ label: "Stock at cost", node: <Money cents={data.overview.stockCostValueCents} />, sub: `${data.overview.stockUnits.toLocaleString("en-US")} units` });
  }
  return (
    <View style={s.grid}>
      {items.map((i) => (
        <View key={i.label} style={s.kpi}>
          <Text style={s.tileLabel}>{i.label}</Text>
          {i.node}
          {i.sub ? <Text style={s.kpiSub}>{i.sub}</Text> : null}
        </View>
      ))}
    </View>
  );
}

// ---------- trend
function TrendCard({ data, range }: { data: Analytics; range: AnalyticsRange }) {
  const bars = useMemo(() => buildBars(data.trend, range), [data.trend, range]);
  const totals = channelTotals(data.channels);
  const sum = totals.reduce((a, t) => a + t.revenueCents, 0);
  const grain = range === "7" || range === "30" ? "day by day" : range === "90" ? "week by week" : "month by month";
  return (
    <Card>
      <Text style={s.tileLabel}>Revenue trend</Text>
      <Money cents={data.summary.revenueCents} style={{ fontSize: 28, marginTop: 4 }} />
      <Text style={text.sub}>
        {periodLabel(range)}, {grain}
      </Text>
      <Delta now={data.summary.revenueCents} before={data.previous?.revenueCents} range={range} />
      <View style={{ marginTop: 14 }}>
        <TrendChart bars={bars} />
      </View>
      {sum > 0 ? (
        <View style={{ marginTop: 16 }}>
          <SplitBar items={totals.map((t) => ({ key: t.sourceType, value: t.revenueCents }))} />
          <View style={s.chips}>
            {totals.map((t) => (
              <View key={t.sourceType} style={s.chip}>
                <View style={row.between}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <View style={[s.sq, { backgroundColor: channelColor(t.sourceType) }]} />
                    <Text style={s.chipLabel}>{CHANNEL_LABEL[t.sourceType] ?? t.sourceType}</Text>
                  </View>
                  <Text style={s.mono}>{((t.revenueCents / sum) * 100).toFixed(0)}%</Text>
                </View>
                <Text style={s.chipValue}>{formatKes(t.revenueCents)}</Text>
              </View>
            ))}
          </View>
        </View>
      ) : null}
    </Card>
  );
}

// ---------- payment methods
function PaymentCard({ data }: { data: Analytics }) {
  const total = data.paymentMethods.reduce((a, m) => a + m.totalCents, 0) || 1;
  return (
    <Card>
      <Text style={text.title}>Payment methods</Text>
      <Text style={text.sub}>How customers paid.</Text>
      {data.paymentMethods.length === 0 ? <Text style={[text.sub, s.none]}>No payments yet.</Text> : null}
      <View style={{ marginTop: 10, gap: 12 }}>
        {data.paymentMethods.map((m) => (
          <View key={m.method}>
            <View style={row.between}>
              <Text style={s.rowName}>{humanize(m.method)}</Text>
              <Text style={s.mono}>
                {compact(m.totalCents / 100)} · {m.count}
              </Text>
            </View>
            <View style={{ marginTop: 5 }}>
              <HBar pct={m.totalCents / total} />
            </View>
          </View>
        ))}
      </View>
    </Card>
  );
}

// ---------- revenue by channel
function ChannelCard({ data }: { data: Analytics }) {
  const total = data.channels.reduce((a, c) => a + c.revenueCents, 0) || 1;
  return (
    <Card>
      <Text style={text.title}>Revenue by channel</Text>
      {data.channels.length === 0 ? <Text style={[text.sub, s.none]}>No sales yet.</Text> : null}
      {data.channels.map((c, i) => (
        <View key={`${c.sourceType}-${c.channelName}`} style={[s.line, i === 0 && { borderTopWidth: 0 }]}>
          <View style={row.between}>
            <View style={{ flexShrink: 1 }}>
              <Text style={s.rowName}>{c.channelName}</Text>
              <Text style={text.sub}>
                {c.transactions} transactions · avg {formatKes(c.avgBasketCents)}
              </Text>
            </View>
            <View style={{ alignItems: "flex-end" }}>
              <Text style={s.rowName}>{formatKes(c.revenueCents)}</Text>
              <Text style={s.mono}>{((c.revenueCents / total) * 100).toFixed(1)}%</Text>
            </View>
          </View>
        </View>
      ))}
    </Card>
  );
}

// ---------- order pipeline (not on the web dashboard: it is the quickest read on what is stuck)
function PipelineCard({ data }: { data: Analytics }) {
  const rows = (data.overview?.orderStatus ?? []).filter((o) => o.count > 0);
  if (rows.length === 0) return null;
  return (
    <Card>
      <Text style={text.title}>Order pipeline</Text>
      <Text style={text.sub}>Every open and closed order by stage, with money still owed.</Text>
      {rows.map((o, i) => (
        <View key={o.status} style={[s.line, i === 0 && { borderTopWidth: 0 }]}>
          <View style={row.between}>
            <Text style={s.rowName}>{humanize(o.status)}</Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              {o.outstandingCents > 0 ? <Text style={[s.mono, { color: colors.redText }]}>owed {formatKes(o.outstandingCents)}</Text> : null}
              <Pill text={String(o.count)} />
            </View>
          </View>
        </View>
      ))}
    </Card>
  );
}

// ---------- top products
function TopProductsCard({ data }: { data: Analytics }) {
  const channels = Object.keys(data.topByChannel).filter((k) => (data.topByChannel[k]?.length ?? 0) > 0);
  return (
    <Card>
      <Text style={text.title}>Top products by channel</Text>
      <Text style={text.sub}>Which products move where.</Text>
      {channels.length === 0 ? <Text style={[text.sub, s.none]}>No sales yet.</Text> : null}
      {channels.map((ch) => (
        <View key={ch} style={{ marginTop: 14 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <View style={[s.sq, { backgroundColor: channelColor(ch) }]} />
            <Text style={[text.mono, { color: colors.muted }]}>{CHANNEL_LABEL[ch] ?? ch}</Text>
          </View>
          {(data.topByChannel[ch] ?? []).map((p, i) => (
            <View key={p.id} style={[s.line, i === 0 && { borderTopWidth: 0 }]}>
              <View style={row.between}>
                <Text style={[s.rowName, { flexShrink: 1 }]} numberOfLines={1}>
                  {p.name}
                </Text>
                <Text style={s.mono}>
                  {p.unitsSold}× · {formatAmount(p.revenueCents)}
                </Text>
              </View>
            </View>
          ))}
        </View>
      ))}
    </Card>
  );
}

const s = StyleSheet.create({
  lede: { fontSize: 13, color: colors.muted, paddingHorizontal: 16, marginTop: 6 },
  range: {
    flexDirection: "row",
    marginHorizontal: 16,
    marginTop: 14,
    padding: 4,
    gap: 2,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  rangeBtn: { flex: 1, minHeight: MIN_TOUCH - 6, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  rangeBtnOn: { backgroundColor: colors.ink },
  rangeText: { fontSize: 12, fontWeight: "600", color: colors.muted },
  rangeTextOn: { color: colors.paper },

  today: { marginHorizontal: 16, marginTop: 12, padding: 16, borderRadius: 16, backgroundColor: colors.ink },
  todayBig: { fontSize: 34, fontWeight: "700", color: colors.paper, marginTop: 6, letterSpacing: -0.5 },
  todayKes: { fontSize: 16, fontWeight: "500", color: colors.mono },
  todayRow: { flexDirection: "row", gap: 10, marginTop: 14, paddingTop: 12, borderTopWidth: 1, borderTopColor: "rgba(255,255,255,0.12)" },
  todayLabel: { fontSize: 11, color: colors.mono },
  todayVal: { fontSize: 14, fontWeight: "600", color: colors.paper, marginVertical: 2 },

  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginHorizontal: 16, marginTop: 12 },
  tile: {
    flexBasis: "48%",
    flexGrow: 1,
    padding: 14,
    borderRadius: radius.card + 4,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  tileLabel: { fontSize: 12, color: colors.muted, fontWeight: "500" },
  tileCount: { fontSize: 30, fontWeight: "700", marginTop: 4, letterSpacing: -0.5 },
  tileDetail: { fontSize: 11, color: colors.muted, marginTop: 4 },
  kpi: {
    flexBasis: "48%",
    flexGrow: 1,
    padding: 14,
    borderRadius: radius.card + 4,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  kpiSub: { fontSize: 11, color: colors.muted, marginTop: 4 },
  big: { fontSize: 22, fontWeight: "700", color: colors.ink, marginTop: 6, letterSpacing: -0.4 },
  kes: { fontSize: 11, fontWeight: "500", color: colors.muted },

  delta: { alignSelf: "flex-start", marginTop: 8, paddingVertical: 3, paddingHorizontal: 8, borderRadius: 99 },
  deltaText: { fontSize: 12, fontWeight: "600" },

  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 },
  chip: { flexBasis: "47%", flexGrow: 1, padding: 10, borderRadius: 12, backgroundColor: colors.paper },
  chipLabel: { fontSize: 12, color: colors.muted },
  chipValue: { fontSize: 14, fontWeight: "700", color: colors.ink, marginTop: 4 },
  sq: { width: 10, height: 10, borderRadius: 2 },
  mono: { fontFamily: "monospace", fontSize: 12, color: colors.muted },
  rowName: { fontSize: 14, fontWeight: "600", color: colors.text },
  line: { paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.lineSoft },
  none: { textAlign: "center", paddingVertical: 12 },
});
