import { useNavigation } from "@react-navigation/native";
import React from "react";
import { ActivityIndicator, Alert, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { api } from "../api";
import { useAuth } from "../auth/AuthContext";
import { Header } from "../components/Header";
import { Banner, Card, Empty, row, text } from "../components/ui";
import { timeAgo } from "../lib/format";
import { useRemote } from "../lib/useRemote";
import { openDeepLink } from "../navigation/linking";
import { colors } from "../theme";

export default function AlertsScreen() {
  const nav = useNavigation<any>();
  const { offline } = useAuth();
  const { data, loading, refreshing, error, refresh } = useRemote("notifications", (t) => api.notifications(t));

  return (
    <View style={{ flex: 1, backgroundColor: colors.paper }}>
      <Header eyebrow="Urban Trends" title="Alerts" onBack={() => nav.goBack()} />
      {offline ? <Banner text="Offline · showing saved alerts." /> : error ? <Banner text={error} /> : null}
      {loading && !data ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={colors.ink} />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingBottom: 24 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.ink} colors={[colors.amber]} />}
        >
          {data && data.items.length === 0 ? <Empty title="No alerts" /> : null}
          {data?.items.map((n) => (
            <Card
              key={n.id}
              onPress={() => {
                if (!openDeepLink(nav, n.deepLink)) Alert.alert(n.title, "This screen is built in a later release.");
              }}
            >
              <View style={row.between}>
                <View style={{ flexDirection: "row", alignItems: "center", flexShrink: 1, gap: 8 }}>
                  {!n.read ? <View style={s.dot} /> : null}
                  <Text style={[text.title, { flexShrink: 1 }]}>{n.title}</Text>
                </View>
                <Text style={text.sub}>{timeAgo(n.createdAt)}</Text>
              </View>
              <Text style={text.sub}>{n.body}</Text>
            </Card>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.amber },
});
