import { useFocusEffect, useNavigation } from "@react-navigation/native";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { api } from "../api";
import { isApiError } from "../api/errors";
import type { AttentionItem, HomeAttention, HomeSummary } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { Header } from "../components/Header";
import { Banner, Card, Pill, row, text } from "../components/ui";
import { openDeepLink } from "../navigation/linking";
import { formatAmount, timeAgo } from "../lib/format";
import { homeCache } from "../lib/storage";
import { colors } from "../theme";

interface HomeData {
  attention: HomeAttention;
  summary: HomeSummary;
  savedAt: string;
}

export default function HomeScreen() {
  const { user, request, offline } = useAuth();
  const nav = useNavigation<any>();
  const [data, setData] = useState<HomeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cacheLoaded = useRef(false);

  // Show cached data immediately (cold-start target is under 3 s), then fetch.
  useEffect(() => {
    if (!user || cacheLoaded.current) return;
    cacheLoaded.current = true;
    homeCache
      .load(user.id)
      .then((c) => {
        if (c) setData((cur) => cur ?? { attention: c.attention, summary: c.summary, savedAt: c.savedAt });
      })
      .catch(() => {});
  }, [user]);

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const [attention, summary] = await Promise.all([
        request((t) => api.homeAttention(t)),
        request((t) => api.homeSummary(t)),
      ]);
      const savedAt = new Date().toISOString();
      setData({ attention, summary, savedAt });
      setError(null);
      homeCache.save({ userId: user.id, savedAt, attention, summary }).catch(() => {});
    } catch (e) {
      // offline keeps the cached view; a revoked session is handled by the auth layer
      if (!isApiError(e) || e.code !== "NETWORK") setError(isApiError(e) ? e.message : "Could not refresh");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [user, request]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  function open(item: AttentionItem) {
    if (!openDeepLink(nav, item.deepLink)) Alert.alert(item.title, "This screen is built in a later release.");
  }

  const total = data?.attention.total ?? 0;

  return (
    <View style={{ flex: 1, backgroundColor: colors.paper }}>
      <Header
        eyebrow="Urban Trends · Today"
        action={{ label: "Alerts", onPress: () => nav.navigate("Alerts") }}
        title={data ? (total > 0 ? `Needs you · ${total}` : "All clear") : "Needs you"}
        right={data ? <Pill text={`Synced ${timeAgo(data.savedAt)}`} /> : undefined}
      />
      {offline ? (
        <Banner text="Offline · showing saved data. Actions need a connection." />
      ) : error ? (
        <Banner text={error} />
      ) : null}

      {loading && !data ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={colors.ink} />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingBottom: 24 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                load();
              }}
              tintColor={colors.ink}
              colors={[colors.amber]}
            />
          }
        >
          {data && data.attention.items.length === 0 ? (
            <Card>
              <Text style={text.title}>Nothing needs your attention</Text>
              <Text style={text.sub}>Approvals, unpaid parcels, payments and stock are all in order.</Text>
            </Card>
          ) : null}

          {data?.attention.items.map((item) => (
            <Card key={item.id} onPress={() => open(item)}>
              <View style={row.between}>
                <Text style={[text.title, { flexShrink: 1 }]}>{item.title}</Text>
                {item.badge ? <Pill text={item.badge} tone={item.urgent ? "red" : "amber"} /> : null}
              </View>
              <Text style={text.sub}>{item.subtitle}</Text>
            </Card>
          ))}

          {data ? (
            <Card>
              <View style={[row.between, { alignItems: "flex-start" }]}>
                <Stat label="Sales" value={formatAmount(data.summary.salesCents)} />
                <Stat label="Orders" value={String(data.summary.orders)} />
                <Stat label="Cash variance" value={formatAmount(data.summary.cashVarianceCents)} />
              </View>
            </Card>
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ alignItems: "center", flex: 1 }}>
      <Text style={text.sub}>{label}</Text>
      <Text style={s.statValue}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  statValue: { fontWeight: "600", fontSize: 15, color: colors.text, marginTop: 2 },
});
