import { useNavigation, useRoute } from "@react-navigation/native";
import React from "react";
import { ActivityIndicator, Alert, Linking, ScrollView, Text, View } from "react-native";
import { api } from "../api";
import { useAuth } from "../auth/AuthContext";
import { Header } from "../components/Header";
import { Banner, Card, Empty, Pill, PrimaryButton, row, text } from "../components/ui";
import { formatKes, timeAgo } from "../lib/format";
import { orderStatusLabel, paymentLabel } from "../lib/labels";
import { telUrl, whatsappUrl } from "../lib/phone";
import { useRemote } from "../lib/useRemote";
import { colors } from "../theme";

async function open(url: string | null) {
  if (!url) return;
  try {
    await Linking.openURL(url);
  } catch {
    Alert.alert("Could not open", "This phone has no app to handle that.");
  }
}

export default function OrderDetailScreen() {
  const nav = useNavigation<any>();
  const { id } = useRoute<any>().params as { id: number };
  const { offline } = useAuth();
  const { data: o, loading, error } = useRemote(`order:${id}`, (t) => api.order(t, id));

  return (
    <View style={{ flex: 1, backgroundColor: colors.paper }}>
      <Header eyebrow="Order" title={o?.number ?? "Order"} onBack={() => nav.goBack()} />
      {offline ? <Banner text="Offline · showing saved data." /> : error ? <Banner text={error} /> : null}
      {loading && !o ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={colors.ink} />
      ) : !o ? (
        <Empty title="Order not available" note="Open it again when you have a connection." />
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
          <Card>
            <View style={row.between}>
              <Text style={text.title}>{o.customerName}</Text>
              <Pill text={paymentLabel[o.paymentState]} tone={o.paymentState === "paid" ? "amber" : "red"} />
            </View>
            <Text style={text.sub}>
              {orderStatusLabel[o.status]} · {timeAgo(o.createdAt)}
            </Text>
          </Card>
          <Card>
            <Text style={text.title}>Items</Text>
            {o.items.map((it, i) => (
              <View key={i} style={[row.between, { paddingVertical: 6 }]}>
                <Text style={[text.sub, { marginTop: 0, flexShrink: 1 }]}>
                  {it.qty} × {it.name}
                </Text>
                {it.priceCents !== null ? <Text style={[text.sub, { marginTop: 0 }]}>{formatKes(it.priceCents * it.qty)}</Text> : null}
              </View>
            ))}
            <View style={[row.between, { paddingTop: 6 }]}>
              <Text style={[text.sub, { marginTop: 0 }]}>Delivery fee</Text>
              <Text style={[text.sub, { marginTop: 0 }]}>{formatKes(o.deliveryFeeCents)}</Text>
            </View>
            <View style={[row.between, { paddingTop: 8 }]}>
              <Text style={text.title}>Total</Text>
              <Text style={text.title}>{formatKes(o.totalCents)}</Text>
            </View>
          </Card>
          {o.courier ? (
            <Card>
              <Text style={text.title}>Courier · {o.courier}</Text>
              {o.courierPhone ? (
                <>
                  <PrimaryButton label="Call courier" onPress={() => open(telUrl(o.courierPhone as string))} />
                  <PrimaryButton label="WhatsApp courier" variant="ghost" onPress={() => open(whatsappUrl(o.courierPhone as string))} />
                </>
              ) : (
                <Text style={text.sub}>No phone number on file.</Text>
              )}
            </Card>
          ) : null}
          {o.notes ? (
            <Card>
              <Text style={text.title}>Notes</Text>
              <Text style={text.sub}>{o.notes}</Text>
            </Card>
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}
