import { useNavigation, useRoute } from "@react-navigation/native";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { api } from "../../api";
import { isApiError } from "../../api/errors";
import type { CourierBalance, CourierCollection, CourierRemittance } from "../../api/typesV11";
import { useAuth } from "../../auth/AuthContext";
import { Card, Empty, PrimaryButton, row, text } from "../../components/ui";
import { formatKes, timeAgo } from "../../lib/format";
import { centsToInput, parseKesToCents } from "../../lib/money";
import { exceedsCollections, remittanceVariance, selectionTotals } from "../../lib/remittance";
import { useSecureScreen } from "../../lib/secureScreen";
import { MIN_TOUCH, colors, radius } from "../../theme";
import { Field, Page, errText } from "./common";

export default function RemittanceScreen() {
  const nav = useNavigation<any>();
  const { courier } = useRoute<any>().params as { courier: CourierBalance };
  const { request, offline } = useAuth();
  useSecureScreen("remittance");
  const [cols, setCols] = useState<CourierCollection[]>([]);
  const [hist, setHist] = useState<CourierRemittance[]>([]);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [received, setReceived] = useState("");
  const [touched, setTouched] = useState(false);
  const [ref, setRef] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [c, h] = await Promise.all([request((t) => api.courierCollections(t, courier.courierId)), request((t) => api.courierRemittances(t, courier.courierId))]);
      setCols(c); setHist(h.items); setPicked(new Set()); setError(null);
    } catch (e) { setError(errText(e)); }
  }, [request, courier.courierId]);
  useEffect(() => { load(); }, [load]);

  const tot = useMemo(() => selectionTotals(cols, picked), [cols, picked]);
  // until the person types a figure, assume the courier hands over exactly what is expected
  useEffect(() => { if (!touched) setReceived(tot.count ? centsToInput(tot.expectedCents) : ""); }, [tot.expectedCents, tot.count, touched]);
  const cents = parseKesToCents(received);
  const v = cents !== null ? remittanceVariance(cents, tot.expectedCents) : null;
  const tooMuch = cents !== null && exceedsCollections(cents, tot);
  const toggle = (id: number) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  function submit() {
    if (cents === null || !tot.count) return;
    Alert.alert("Record this remittance?", `${tot.count} parcels · expected ${formatKes(tot.expectedCents)} · received ${formatKes(cents)}${v && v.kind !== "exact" ? ` · ${v.kind === "short" ? "short" : "over"} by ${formatKes(Math.abs(v.diffCents))}` : ""}. It cannot be undone.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Record", onPress: async () => {
        setBusy(true);
        try {
          const r = await request((t) => api.createRemittance(t, courier.courierId, { collectionIds: [...picked], remittedCents: cents, reference: ref.trim() || undefined, note: note.trim() || undefined }));
          Alert.alert("Recorded", `${r.settledCount} parcels settled.`);
          setTouched(false); setRef(""); setNote(""); load();
        } catch (e) { setError(errText(e)); if (isApiError(e) && e.code === "ALREADY_SETTLED") load(); } finally { setBusy(false); }
      } },
    ]);
  }

  return (
    <Page eyebrow="Courier remittance" title={courier.name} onBack={() => nav.goBack()} error={error} onRefresh={load}>
      {cols.length === 0 ? <Empty title="Nothing open to settle" /> : <Text style={[text.sub, { marginHorizontal: 16, marginTop: 8 }]}>Tick the parcels this payment covers.</Text>}
      {cols.map((c) => {
        const on = picked.has(c.collectionId);
        return (
          <Pressable key={c.collectionId} onPress={() => toggle(c.collectionId)} accessibilityRole="checkbox" accessibilityState={{ checked: on }} style={[s.row, on && s.rowOn]}>
            <View style={[s.box, on && { backgroundColor: colors.ink }]}>{on ? <Text style={{ color: colors.paper }}>✓</Text> : null}</View>
            <View style={{ flex: 1 }}>
              <Text style={text.title}>{c.orderNumber} · {c.customerName}</Text>
              <Text style={text.sub}>Collected {c.collectedOn}{c.feeCents ? ` · fee ${formatKes(c.feeCents)}` : ""}</Text>
            </View>
            <Text style={text.title}>{formatKes(c.amountCents)}</Text>
          </Pressable>
        );
      })}
      {tot.count ? (
        <Card>
          <View style={row.between}><Text style={text.sub}>Collected</Text><Text style={text.title}>{formatKes(tot.collectionsCents)}</Text></View>
          <View style={row.between}><Text style={text.sub}>Fees we owe them</Text><Text style={text.title}>− {formatKes(tot.feesCents)}</Text></View>
          <View style={row.between}><Text style={text.title}>Expected</Text><Text style={text.title}>{formatKes(tot.expectedCents)}</Text></View>
          <Field label="Amount received (KES)" value={received} onChangeText={(t) => { setTouched(true); setReceived(t); }} keyboardType="decimal-pad" />
          {v && v.kind !== "exact" ? <Text style={{ marginTop: 6, fontWeight: "600", color: v.kind === "short" ? colors.redText : colors.ink }}>{v.kind === "short" ? "Short" : "Over"} by {formatKes(Math.abs(v.diffCents))}</Text> : null}
          {tooMuch ? <Text style={{ marginTop: 6, color: colors.redText }}>That is more than was collected.</Text> : null}
          <Field label="Reference (optional)" value={ref} onChangeText={setRef} />
          <Field label="Note (optional)" value={note} onChangeText={setNote} />
          <PrimaryButton label="Record remittance" onPress={submit} loading={busy} disabled={cents === null || tooMuch || offline} />
        </Card>
      ) : null}
      {hist.length ? <Text style={[text.mono, { marginHorizontal: 16, marginTop: 20 }]}>Past remittances</Text> : null}
      {hist.map((h) => (
        <Card key={h.id}>
          <View style={row.between}><Text style={text.title}>{formatKes(h.remittedCents)}</Text><Text style={text.sub}>{timeAgo(h.createdAt)}</Text></View>
          <Text style={text.sub}>{h.createdBy.name}{h.reference ? ` · ${h.reference}` : ""}{h.cashVarianceCents ? ` · variance ${formatKes(h.cashVarianceCents)}` : ""}</Text>
        </Card>
      ))}
    </Page>
  );
}
const s = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 12, marginHorizontal: 16, marginTop: 8, padding: 12, minHeight: MIN_TOUCH, borderWidth: 1, borderColor: colors.line, borderRadius: radius.card, backgroundColor: colors.surface },
  rowOn: { borderColor: colors.amber, backgroundColor: colors.amberSoft },
  box: { width: 26, height: 26, borderRadius: 6, borderWidth: 1.5, borderColor: colors.ink, alignItems: "center", justifyContent: "center" },
});
