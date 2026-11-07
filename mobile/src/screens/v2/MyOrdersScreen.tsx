import { useFocusEffect, useNavigation } from "@react-navigation/native";
import React, { useCallback, useRef, useState } from "react";
import { Text, View } from "react-native";
import { api } from "../../api";
import type { TelesalesOrderSummary } from "../../api/typesV2";
import { useAuth } from "../../auth/AuthContext";
import { Card, Empty, Pill, PrimaryButton, row, text } from "../../components/ui";
import { formatKes, timeAgo } from "../../lib/format";
import { useSecureScreen } from "../../lib/secureScreen";
import { Page, errText } from "../v11/common";
import { CountdownPill, useMinuteTick } from "./shared";

export default function MyOrdersScreen() {
  const nav = useNavigation<any>();
  const { request } = useAuth();
  useSecureScreen("my-orders");
  const now = useMinuteTick();
  const [items, setItems] = useState<TelesalesOrderSummary[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [serverTime, setServerTime] = useState<string | null>(null);
  const fetchedAt = useRef(Date.now());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (cursor?: string) => {
    setLoading(true);
    try {
      const p = await request((t) => api.telesalesOrders(t, cursor));
      setItems((prev) => (cursor ? [...prev, ...p.items] : p.items));
      setNext(p.nextCursor); setTotal(p.total); setServerTime(p.serverTime); fetchedAt.current = Date.now(); setError(null);
    } catch (e) { setError(errText(e)); } finally { setLoading(false); }
  }, [request]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  return (
    <Page eyebrow="Telesales" title="My orders" onBack={() => nav.goBack()} error={error} onRefresh={() => load()} refreshing={loading && items.length > 0}>
      {total !== null ? <Text style={[text.sub, { marginHorizontal: 16, marginTop: 8 }]}>{total === 0 ? "Nothing waiting for a call." : `${total} waiting for your call, oldest first.`}</Text> : null}
      {total === 0 ? <Empty title="All caught up" note="New online orders assigned to you show up here." /> : null}
      {items.map((o) => (
        <Card key={o.id} onPress={() => nav.navigate("ConfirmOrder", { id: o.id })}>
          <View style={row.between}>
            <Text style={[text.title, { flex: 1 }]}>{o.number} · {o.customer.name}</Text>
            <CountdownPill confirmBy={o.confirmBy} serverTime={serverTime} fetchedAt={fetchedAt.current} now={now} />
          </View>
          <Text style={text.sub}>{o.customer.city ?? ""}{o.customer.city ? " · " : ""}{o.itemCount ?? 0} items · {formatKes(o.totalCents)} · ordered {timeAgo(o.createdAt)}</Text>
          <View style={{ flexDirection: "row", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
            {o.duplicateCount ? <Pill text="Same phone as another order" tone="red" /> : null}
            {o.callbackAt ? <Pill text={`Call back ${new Date(o.callbackAt).toLocaleString("en-KE", { weekday: "short", hour: "2-digit", minute: "2-digit" })}`} /> : null}
          </View>
        </Card>
      ))}
      {next ? <View style={{ marginHorizontal: 16 }}><PrimaryButton variant="ghost" label="Load more" onPress={() => load(next)} loading={loading} /></View> : null}
    </Page>
  );
}
