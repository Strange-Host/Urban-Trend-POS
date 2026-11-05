import { useNavigation, useRoute } from "@react-navigation/native";
import React, { useCallback, useEffect, useState } from "react";
import { Alert, Text, View } from "react-native";
import { api } from "../../api";
import type { StockTakeDetail } from "../../api/typesV11";
import { useAuth } from "../../auth/AuthContext";
import { Card, Pill, PrimaryButton, row, text } from "../../components/ui";
import { timeAgo } from "../../lib/format";
import { can } from "../../lib/permissions";
import { colors } from "../../theme";
import { Field, Page, errText } from "./common";
import { STATUS_LABEL } from "./StockTakesScreen";

export default function StockTakeDetailScreen() {
  const nav = useNavigation<any>();
  const { id } = useRoute<any>().params as { id: number };
  const { request, user, offline } = useAuth();
  const [d, setD] = useState<StockTakeDetail | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setD(await request((t) => api.stockTake(t, id))); setError(null); } catch (e) { setError(errText(e)); }
  }, [request, id]);
  useEffect(() => { load(); }, [load]);

  async function decide(kind: "approve" | "reject") {
    if (kind === "reject" && !reason.trim()) { setError("Say why you are rejecting this count."); return; }
    setBusy(true);
    try {
      setD(await request((t) => (kind === "approve" ? api.approveStockTake(t, id) : api.rejectStockTake(t, id, reason.trim()))));
      setError(null);
      Alert.alert(kind === "approve" ? "Approved. Stock updated." : "Rejected. Stock was not changed.");
    } catch (e) { setError(errText(e)); load(); } finally { setBusy(false); }
  }

  const review = d?.status === "pending_approval" && can(user, "stock.review");
  return (
    <Page eyebrow="Stock-take" title={d?.scope.categoryName ?? "Whole shop"} onBack={() => nav.goBack()} error={error} onRefresh={load}>
      {d ? (
        <>
          <Card>
            <View style={row.between}><Text style={text.title}>{d.createdBy.name}</Text><Pill text={STATUS_LABEL[d.status]} tone={d.status === "rejected" ? "red" : "amber"} /></View>
            <Text style={text.sub}>{d.lineCount} counted · {d.varianceUnits} units difference · {timeAgo(d.createdAt)}</Text>
            {d.note ? <Text style={text.sub}>“{d.note}”</Text> : null}
            {d.reviewNote ? <Text style={text.sub}>Review: {d.reviewNote}</Text> : null}
          </Card>
          {d.lines.map((l) => (
            <Card key={l.productId}>
              <View style={row.between}><Text style={[text.title, { flex: 1 }]} numberOfLines={2}>{l.name}</Text>{l.needsApproval ? <Pill text={l.applied ? "Approved" : "Needs approval"} /> : null}</View>
              <View style={[row.between, { marginTop: 4 }]}>
                <Text style={text.sub}>System {l.systemQty} → counted {l.countedQty}</Text>
                <Text style={{ fontWeight: "600", color: l.variance < 0 ? colors.redText : colors.ink }}>{l.variance > 0 ? "+" : ""}{l.variance}</Text>
              </View>
            </Card>
          ))}
          {review ? (
            <Card>
              <Text style={text.title}>Decision</Text>
              <Text style={text.sub}>Approving applies every difference in this count to stock.</Text>
              <PrimaryButton label="Approve count" onPress={() => decide("approve")} loading={busy} disabled={offline} />
              <Field label="Reason (needed to reject)" value={reason} onChangeText={setReason} />
              <PrimaryButton variant="ghost" label="Reject" onPress={() => decide("reject")} disabled={busy || offline} />
            </Card>
          ) : null}
        </>
      ) : null}
    </Page>
  );
}
