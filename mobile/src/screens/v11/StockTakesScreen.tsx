import { useFocusEffect, useNavigation } from "@react-navigation/native";
import React, { useCallback, useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { api } from "../../api";
import type { Category, StockTake, StockTakeStatus } from "../../api/typesV11";
import { useAuth } from "../../auth/AuthContext";
import { Card, Chip, Empty, Pill, PrimaryButton, row, text } from "../../components/ui";
import { timeAgo } from "../../lib/format";
import { can } from "../../lib/permissions";
import { Field, Page, errText } from "./common";

export const STATUS_LABEL: Record<StockTakeStatus, string> = { draft: "Counting", pending_approval: "Needs approval", applied: "Applied", rejected: "Rejected" };

export default function StockTakesScreen() {
  const nav = useNavigation<any>();
  const { request, user, offline } = useAuth();
  const [items, setItems] = useState<StockTake[]>([]);
  const [cats, setCats] = useState<Category[]>([]);
  const [scope, setScope] = useState<number | "all">("all");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canStart = can(user, "stock.count");

  const load = useCallback(async () => {
    try { setItems((await request((t) => api.stockTakes(t, {}))).items); setError(null); } catch (e) { setError(errText(e)); }
  }, [request]);
  useFocusEffect(useCallback(() => { load(); }, [load]));
  useEffect(() => { request((t) => api.categories(t)).then(setCats).catch(() => {}); }, [request]);

  async function start() {
    setBusy(true); setError(null);
    try {
      const t = await request((t2) => api.startStockTake(t2, scope === "all" ? { type: "all" } : { type: "category", categoryId: scope }, note.trim() || undefined));
      setNote("");
      nav.navigate("StockTakeCount", { id: t.id });
    } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  }

  const open = (t: StockTake) => nav.navigate(t.status === "draft" ? "StockTakeCount" : "StockTakeDetail", { id: t.id });
  return (
    <Page eyebrow="Stock" title="Stock-take" onBack={() => nav.goBack()} error={error} onRefresh={load}>
      {canStart ? (
        <Card>
          <Text style={text.title}>Start a count</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 8 }}>
            <Chip label="Whole shop" active={scope === "all"} onPress={() => setScope("all")} />
            {cats.filter((c) => c.isActive).map((c) => <Chip key={c.id} label={c.name} active={scope === c.id} onPress={() => setScope(c.id)} />)}
          </ScrollView>
          <Field label="Note (optional)" value={note} onChangeText={setNote} />
          <PrimaryButton label="Start counting" onPress={start} loading={busy} disabled={offline} />
        </Card>
      ) : null}
      {items.length === 0 ? <Empty title="No stock-takes yet" /> : null}
      {items.map((t) => (
        <Card key={t.id} onPress={() => open(t)}>
          <View style={row.between}>
            <Text style={[text.title, { flex: 1 }]}>{t.scope.categoryName ?? "Whole shop"}</Text>
            <Pill text={STATUS_LABEL[t.status]} tone={t.status === "rejected" ? "red" : "amber"} />
          </View>
          <Text style={text.sub}>{t.lineCount} counted · {t.createdBy.name} · {timeAgo(t.createdAt)}</Text>
          {t.status !== "draft" ? <Text style={text.sub}>{t.varianceUnits} units difference{t.needsApprovalCount ? ` · ${t.needsApprovalCount} need approval` : ""}</Text> : null}
        </Card>
      ))}
    </Page>
  );
}
