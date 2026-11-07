import { useNavigation, useRoute } from "@react-navigation/native";
import React, { useEffect, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, Text, View } from "react-native";
import { api } from "../api";
import { isApiError } from "../api/errors";
import type { OrderStatus, OrderSummary, OrdersPage } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { Header } from "../components/Header";
import { Banner, Card, Chip, Empty, Pill, PrimaryButton, row, text } from "../components/ui";
import { ageShort } from "../lib/age";
import { formatKes } from "../lib/format";
import { orderStatusLabel, paymentLabel } from "../lib/labels";
import { useRemote } from "../lib/useRemote";
import { colors } from "../theme";

// "Unpaid" (its own chip) already covers dispatched_unpaid and dispatched_partial.
const STATUS_CHIPS: OrderStatus[] = ["awaiting_dispatch", "dispatched_paid", "returned_awaiting_inspection", "returned_resellable", "returned_damaged", "cancelled"];

export default function OrdersScreen() {
  const nav = useNavigation<any>();
  const route = useRoute<any>();
  const { request, offline } = useAuth();
  const [status, setStatus] = useState<OrderStatus | undefined>();
  const [courier, setCourier] = useState<string | undefined>();
  const [unpaid, setUnpaid] = useState(false);
  const [more, setMore] = useState<OrderSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  // deep link "orders?unpaid=1" arrives as a param
  const nonce: number | undefined = route.params?.nonce;
  useEffect(() => {
    if (route.params?.unpaid) setUnpaid(true);
  }, [nonce, route.params?.unpaid]);

  const filters = { status, courier, unpaid: unpaid || undefined };
  const key = `orders:${status ?? "all"}:${courier ?? "all"}:${unpaid ? "unpaid" : "any"}`;
  const { data, loading, refreshing, error, refresh } = useRemote<OrdersPage>(key, (t) => api.orders(t, filters));

  // a fresh first page replaces any pages loaded after it
  useEffect(() => {
    setMore([]);
    setCursor(data?.nextCursor ?? null);
    setMoreError(null);
  }, [data]);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await request((t) => api.orders(t, { ...filters, cursor }));
      setMore((m) => [...m, ...page.items]);
      setCursor(page.nextCursor);
    } catch (e) {
      setMoreError(isApiError(e) ? (e.code === "NETWORK" ? "No connection." : e.message) : "Could not load more");
    } finally {
      setLoadingMore(false);
    }
  }

  const list = [...(data?.items ?? []), ...more];

  return (
    <View style={{ flex: 1, backgroundColor: colors.paper }}>
      <Header eyebrow="Urban Trends" title="Orders" />
      {offline ? <Banner text="Offline · showing saved orders." /> : error ? <Banner text={error} /> : null}
      <View style={{ paddingTop: 10 }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16 }}>
          <Chip label="Unpaid" active={unpaid} onPress={() => setUnpaid((v) => !v)} />
          <Chip label="All" active={!status} onPress={() => setStatus(undefined)} />
          {STATUS_CHIPS.map((st) => (
            <Chip key={st} label={orderStatusLabel[st]} active={status === st} onPress={() => setStatus(status === st ? undefined : st)} />
          ))}
        </ScrollView>
        {data?.couriers.length ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8 }}>
            <Chip label="Any courier" active={!courier} onPress={() => setCourier(undefined)} />
            {data.couriers.map((c) => (
              <Chip key={c} label={c} active={courier === c} onPress={() => setCourier(courier === c ? undefined : c)} />
            ))}
          </ScrollView>
        ) : null}
      </View>
      {loading && !data ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={colors.ink} />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingBottom: 24 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.ink} colors={[colors.amber]} />}
        >
          {data && list.length === 0 ? <Empty title="No orders match" note="Change or clear a filter." /> : null}
          {list.map((o) => (
            <Card key={o.id} onPress={() => nav.navigate("OrderDetail", { id: o.id })}>
              <View style={row.between}>
                <Text style={text.title}>{o.number}</Text>
                <Pill text={paymentLabel[o.paymentState]} tone={o.paymentState === "paid" ? "amber" : "red"} />
              </View>
              <Text style={text.sub}>
                {o.customerName} · {orderStatusLabel[o.status]}
              </Text>
              <View style={[row.between, { marginTop: 4 }]}>
                <Text style={text.sub}>
                  {formatKes(o.totalCents)}
                  {o.courier ? ` · ${o.courier}` : ""}
                </Text>
                <Text style={text.sub}>{ageShort(o.createdAt)}</Text>
              </View>
            </Card>
          ))}
          {moreError ? <Banner text={moreError} /> : null}
          {cursor ? (
            <View style={{ marginHorizontal: 16 }}>
              <PrimaryButton label="Load more" variant="ghost" onPress={loadMore} loading={loadingMore} disabled={offline} />
            </View>
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}
