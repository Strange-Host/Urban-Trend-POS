import { useFocusEffect, useNavigation } from "@react-navigation/native";
import React, { useCallback, useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { api } from "../../api";
import type { Lead, LeadStatus } from "../../api/typesV2";
import { useAuth } from "../../auth/AuthContext";
import { Card, Chip, Empty, Pill, PrimaryButton, row, text } from "../../components/ui";
import { timeAgo } from "../../lib/format";
import { useSecureScreen } from "../../lib/secureScreen";
import { isDueToday } from "../../lib/telesales";
import { MIN_TOUCH, colors, radius } from "../../theme";
import { Page, errText } from "../v11/common";

export const LEAD_LABEL: Record<LeadStatus, string> = { new: "New", contacted: "Contacted", rescheduled: "Call back", converted: "Converted", cancelled: "Cancelled" };
const FILTERS: (LeadStatus | undefined)[] = [undefined, "new", "contacted", "rescheduled", "converted", "cancelled"];

export default function MyLeadsScreen() {
  const nav = useNavigation<any>();
  const { request } = useAuth();
  useSecureScreen("my-leads");
  const [status, setStatus] = useState<LeadStatus | undefined>();
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Lead[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (cursor?: string) => {
    setLoading(true);
    try {
      const p = await request((t) => api.leads(t, { status, q: q.trim() || undefined, cursor }));
      setItems((prev) => (cursor ? [...prev, ...p.items] : p.items));
      setNext(p.nextCursor); setTotal(p.total); setError(null);
    } catch (e) { setError(errText(e)); } finally { setLoading(false); }
  }, [request, status, q]);

  useEffect(() => { const h = setTimeout(() => load(), 250); return () => clearTimeout(h); }, [load]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  // leads whose call-back day has come go first, so nothing promised is forgotten
  const due = items.filter((l) => l.status === "rescheduled" && isDueToday(l.followUpDate));
  const rest = items.filter((l) => !due.includes(l));

  const card = (l: Lead) => (
    <Card key={l.id} onPress={() => nav.navigate("LeadDetail", { id: l.id })}>
      <View style={row.between}>
        <Text style={[text.title, { flex: 1 }]}>{l.name}</Text>
        <Pill text={LEAD_LABEL[l.status]} tone={l.status === "cancelled" ? "red" : "amber"} />
      </View>
      <Text style={text.sub}>{l.phone}{l.interestedProduct?.name ? ` · ${l.interestedProduct.name}` : ""}</Text>
      <Text style={text.sub}>
        {l.status === "rescheduled" && l.followUpDate ? `Call back ${isDueToday(l.followUpDate) ? "today" : l.followUpDate}` : `Added ${timeAgo(l.createdAt)}`}
      </Text>
    </Card>
  );

  return (
    <Page eyebrow="Sales" title="My leads" onBack={() => nav.goBack()} error={error} onRefresh={() => load()} refreshing={loading && items.length > 0}>
      <View style={{ paddingHorizontal: 16, paddingTop: 10 }}>
        <TextInput style={s.search} value={q} onChangeText={setQ} placeholder="Search name or phone" placeholderTextColor={colors.muted} autoCapitalize="none" />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 10 }}>
        {FILTERS.map((f) => <Chip key={f ?? "all"} label={f ? LEAD_LABEL[f] : "All"} active={status === f} onPress={() => setStatus(f)} />)}
      </ScrollView>
      {total !== null ? <Text style={[text.sub, { marginHorizontal: 16, marginTop: 8 }]}>{total} lead{total === 1 ? "" : "s"}</Text> : null}
      {due.length ? <Text style={[text.mono, { marginHorizontal: 16, marginTop: 12 }]}>Call back today</Text> : null}
      {due.map(card)}
      {due.length && rest.length ? <Text style={[text.mono, { marginHorizontal: 16, marginTop: 12 }]}>Everyone else</Text> : null}
      {rest.map(card)}
      {total === 0 ? <Empty title="No leads here" note="Try another filter or search." /> : null}
      {next ? <View style={{ marginHorizontal: 16 }}><PrimaryButton variant="ghost" label="Load more" onPress={() => load(next)} loading={loading} /></View> : null}
    </Page>
  );
}

const s = StyleSheet.create({
  search: { minHeight: MIN_TOUCH, borderWidth: 1, borderColor: colors.line, borderRadius: radius.button, paddingHorizontal: 12, fontSize: 15, color: colors.text, backgroundColor: colors.surface },
});
