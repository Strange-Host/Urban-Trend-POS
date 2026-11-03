import { useNavigation } from "@react-navigation/native";
import React from "react";
import { ActivityIndicator, RefreshControl, ScrollView, Text, View } from "react-native";
import { api } from "../api";
import { useAuth } from "../auth/AuthContext";
import { Header } from "../components/Header";
import { Banner, Card, Empty, Pill, row, text } from "../components/ui";
import { ageShort } from "../lib/age";
import { formatKes, timeAgo } from "../lib/format";
import { approvalTypeLabel } from "../lib/labels";
import { useRemote } from "../lib/useRemote";
import { useSecureScreen } from "../lib/secureScreen";
import { colors } from "../theme";

export default function ApprovalsScreen() {
  useSecureScreen();
  const nav = useNavigation<any>();
  const { offline } = useAuth();
  const { data, savedAt, loading, refreshing, error, refresh } = useRemote("approvals:pending", (t) =>
    api.approvals(t, "pending"),
  );
  const items = data?.items ?? [];

  return (
    <View style={{ flex: 1, backgroundColor: colors.paper }}>
      <Header
        eyebrow="Urban Trends"
        title={data ? `Approvals · ${items.length}` : "Approvals"}
        right={savedAt ? <Pill text={`Synced ${timeAgo(savedAt)}`} /> : undefined}
      />
      {offline ? <Banner text="Offline · showing saved data. Approving needs a connection." /> : error ? <Banner text={error} /> : null}
      {loading && !data ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={colors.ink} />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingBottom: 24 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.ink} colors={[colors.amber]} />}
        >
          {data && items.length === 0 ? <Empty title="No approvals waiting" note="New requests show up here and as a notification." /> : null}
          {items.map((a) => (
            <Card key={a.id} onPress={() => nav.navigate("ApprovalDetail", { id: a.id, approval: a })}>
              <View style={row.between}>
                <Text style={text.title}>
                  {approvalTypeLabel[a.type]}
                  {a.amountCents > 0 ? ` · ${formatKes(a.amountCents)}` : ""}
                </Text>
                <Pill text={ageShort(a.requestedAt)} tone={Date.now() - new Date(a.requestedAt).getTime() > 3 * 3_600_000 ? "red" : "amber"} />
              </View>
              <Text style={text.sub}>{a.requestedBy}</Text>
              <Text style={text.sub} numberOfLines={1}>
                {a.reason}
              </Text>
            </Card>
          ))}
        </ScrollView>
      )}
    </View>
  );
}
