import { useFocusEffect, useNavigation } from "@react-navigation/native";
import React, { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { api } from "../../api";
import type { UnmatchedPayment } from "../../api/typesV11";
import { useAuth } from "../../auth/AuthContext";
import { Card, Empty, PrimaryButton, row, text } from "../../components/ui";
import { formatKes } from "../../lib/format";
import { useSecureScreen } from "../../lib/secureScreen";
import { Page, errText } from "./common";

const age = (m: number) => (m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h` : `${Math.floor(m / 1440)} d`);

export default function PaymentsScreen() {
  const nav = useNavigation<any>();
  const { request } = useAuth();
  useSecureScreen("payments");
  const [items, setItems] = useState<UnmatchedPayment[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [total, setTotal] = useState<{ n: number; cents: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (cursor?: string) => {
    try {
      const p = await request((t) => api.unmatchedPayments(t, cursor));
      setItems((prev) => (cursor ? [...prev, ...p.items] : p.items));
      setNext(p.nextCursor); setTotal({ n: p.total, cents: p.unallocatedCents }); setError(null);
    } catch (e) { setError(errText(e)); }
  }, [request]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  return (
    <Page eyebrow="Money" title="Unmatched payments" onBack={() => nav.goBack()} error={error} onRefresh={() => load()}>
      {total ? <Text style={[text.sub, { marginHorizontal: 16, marginTop: 8 }]}>{total.n} waiting · {formatKes(total.cents)} not yet matched to an order</Text> : null}
      {total && items.length === 0 ? <Empty title="All payments are matched" /> : null}
      {items.map((p) => (
        <Card key={p.id} onPress={() => nav.navigate("PaymentMatch", { payment: p })}>
          <View style={row.between}><Text style={text.title}>{formatKes(p.amountCents)}</Text><Text style={text.sub}>{age(p.ageMinutes)} ago</Text></View>
          <Text style={text.sub}>{p.payerName ?? "Unknown payer"} · {p.method}{p.reference ? ` · ${p.reference}` : ""}</Text>
        </Card>
      ))}
      {next ? <View style={{ marginHorizontal: 16 }}><PrimaryButton variant="ghost" label="Load more" onPress={() => load(next)} /></View> : null}
    </Page>
  );
}
