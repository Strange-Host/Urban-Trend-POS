import { useFocusEffect, useNavigation } from "@react-navigation/native";
import React, { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { api } from "../../api";
import type { CourierBalance } from "../../api/typesV11";
import { useAuth } from "../../auth/AuthContext";
import { Card, Empty, Pill, row, text } from "../../components/ui";
import { formatKes } from "../../lib/format";
import { useSecureScreen } from "../../lib/secureScreen";
import { Page, errText } from "./common";

export default function CouriersScreen() {
  const nav = useNavigation<any>();
  const { request } = useAuth();
  useSecureScreen("couriers");
  const [items, setItems] = useState<CourierBalance[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setItems(await request((t) => api.courierBalances(t))); setError(null); } catch (e) { setError(errText(e)); }
  }, [request]);
  useFocusEffect(useCallback(() => { load(); }, [load]));
  return (
    <Page eyebrow="Money" title="Courier remittance" onBack={() => nav.goBack()} error={error} onRefresh={load}>
      {items && items.length === 0 ? <Empty title="No courier organizations owe cash" /> : null}
      {(items ?? []).map((c) => (
        <Card key={c.courierId} onPress={() => nav.navigate("Remittance", { courier: c })}>
          <View style={row.between}><Text style={[text.title, { flex: 1 }]}>{c.name}</Text>{c.paused ? <Pill text="Paused" tone="red" /> : null}</View>
          <Text style={[text.title, { marginTop: 4 }]}>{formatKes(c.outstandingCents)} owed</Text>
          <Text style={text.sub}>{c.openCollections} open parcels{c.overdueCents > 0 ? ` · ${formatKes(c.overdueCents)} overdue` : ""}{c.oldestCollectionOn ? ` · oldest ${c.oldestCollectionOn}` : ""}</Text>
        </Card>
      ))}
    </Page>
  );
}
