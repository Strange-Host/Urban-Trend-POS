import { useNavigation, useRoute } from "@react-navigation/native";
import React, { useCallback, useEffect, useState } from "react";
import { Alert, Text, View } from "react-native";
import { api } from "../../api";
import { isApiError } from "../../api/errors";
import type { PaymentSuggestion, SuggestionReason, UnmatchedPayment } from "../../api/typesV11";
import { useAuth } from "../../auth/AuthContext";
import { Card, Empty, Pill, PrimaryButton, row, text } from "../../components/ui";
import { formatKes } from "../../lib/format";
import { useSecureScreen } from "../../lib/secureScreen";
import { Field, Page, errText } from "./common";

const WHY: Record<SuggestionReason, string> = { code: "Code matches", amount: "Same amount", phone: "Phone matches", name: "Name matches" };

export default function PaymentMatchScreen() {
  const nav = useNavigation<any>();
  const { payment } = useRoute<any>().params as { payment: UnmatchedPayment };
  const { request, offline } = useAuth();
  useSecureScreen("payment-match");
  const [q, setQ] = useState("");
  const [list, setList] = useState<PaymentSuggestion[]>([]);
  const [ignoring, setIgnoring] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => request((t) => api.paymentSuggestions(t, payment.id, q.trim() || undefined)).then((r) => { setList(r); setError(null); }).catch((e) => setError(errText(e))), [request, payment.id, q]);
  useEffect(() => { const h = setTimeout(load, q ? 300 : 0); return () => clearTimeout(h); }, [load, q]);

  function fail(e: unknown) {
    setError(errText(e));
    if (isApiError(e) && (e.code === "ALREADY_MATCHED" || e.code === "ALREADY_IGNORED")) setTimeout(() => nav.goBack(), 1200);
  }

  function confirm(s: PaymentSuggestion) {
    Alert.alert("Match this payment?", `${formatKes(payment.amountCents)} from ${payment.payerName ?? "unknown"} will be recorded against ${s.number} (${s.customerName}). This cannot be undone here.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Match", onPress: async () => {
        setBusy(true);
        try {
          const r = await request((t) => api.matchPayment(t, payment.id, s.orderId));
          Alert.alert("Matched", r.order.paymentState === "paid" ? `${r.order.number} is now fully paid.` : `${r.order.number} still owes ${formatKes(r.order.balanceCents)}.`);
          nav.goBack();
        } catch (e) { fail(e); } finally { setBusy(false); }
      } },
    ]);
  }

  async function ignore() {
    setBusy(true);
    try { await request((t) => api.ignorePayment(t, payment.id, reason.trim())); nav.goBack(); } catch (e) { fail(e); } finally { setBusy(false); }
  }

  return (
    <Page eyebrow="Unmatched payment" title={formatKes(payment.amountCents)} onBack={() => nav.goBack()} error={error}>
      <Card>
        <Text style={text.title}>{payment.payerName ?? "Unknown payer"}</Text>
        <Text style={text.sub}>{payment.method}{payment.reference ? ` · ${payment.reference}` : ""}</Text>
      </Card>
      <Card><Field label="Search order number, name or phone" value={q} onChangeText={setQ} autoCapitalize="none" /></Card>
      {list.length === 0 ? <Empty title="No likely orders" note="Try a name, phone or order number." /> : null}
      {list.map((s) => (
        <Card key={s.orderId} onPress={() => confirm(s)}>
          <View style={row.between}><Text style={[text.title, { flex: 1 }]}>{s.number} · {s.customerName}</Text><Text style={text.title}>{formatKes(s.balanceCents)}</Text></View>
          <Text style={text.sub}>Owes {formatKes(s.balanceCents)} of {formatKes(s.totalCents)}{s.customerPhone ? ` · ${s.customerPhone}` : ""}</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 6 }}>{s.reasons.map((r) => <Pill key={r} text={WHY[r]} />)}</View>
        </Card>
      ))}
      <View style={{ marginHorizontal: 16, marginTop: 12 }}>
        {ignoring ? (
          <>
            <Field label="Why is this not a sale payment? (required)" value={reason} onChangeText={setReason} />
            <PrimaryButton label="Ignore this payment" onPress={ignore} disabled={!reason.trim() || offline} loading={busy} />
          </>
        ) : <PrimaryButton variant="ghost" label="Not for an order · ignore" onPress={() => setIgnoring(true)} />}
      </View>
    </Page>
  );
}
