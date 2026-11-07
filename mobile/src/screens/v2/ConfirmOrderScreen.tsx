import { useNavigation, useRoute } from "@react-navigation/native";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Text, View } from "react-native";
import { api } from "../../api";
import { isApiError } from "../../api/errors";
import type { TelesalesOrder } from "../../api/typesV2";
import { useAuth } from "../../auth/AuthContext";
import { Card, Chip, Pill, PrimaryButton, row, text } from "../../components/ui";
import { formatKes } from "../../lib/format";
import { useSecureScreen } from "../../lib/secureScreen";
import { callbackChoices } from "../../lib/telesales";
import { Field, Page, errText } from "../v11/common";
import { ContactButtons, CountdownPill, useMinuteTick } from "./shared";

type Mode = "none" | "reschedule" | "cancel";

export default function ConfirmOrderScreen() {
  const nav = useNavigation<any>();
  const { id } = useRoute<any>().params as { id: number };
  const { request, offline } = useAuth();
  useSecureScreen("confirm-order");
  const now = useMinuteTick();
  const [o, setO] = useState<TelesalesOrder | null>(null);
  const fetchedAt = useRef(Date.now());
  const [mode, setMode] = useState<Mode>("none");
  const [pick, setPick] = useState(0);
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setO(await request((t) => api.telesalesOrder(t, id))); fetchedAt.current = Date.now(); setError(null); } catch (e) { setError(errText(e)); }
  }, [request, id]);
  useEffect(() => { load(); }, [load]);

  // while a manager's answer is awaited, look again every few seconds
  const waitingForManager = o?.duplicateApproval?.status === "pending";
  useEffect(() => {
    if (!waitingForManager) return;
    const h = setInterval(load, 6000);
    return () => clearInterval(h);
  }, [waitingForManager, load]);

  async function act(fn: () => Promise<TelesalesOrder>, done?: (r: TelesalesOrder) => void) {
    setBusy(true); setError(null);
    try { const r = await fn(); setO(r); fetchedAt.current = Date.now(); setMode("none"); done?.(r); }
    catch (e) { setError(errText(e)); if (isApiError(e) && ["NOT_AWAITING", "DUPLICATE_PHONE", "CONFLICT"].includes(e.code)) load(); }
    finally { setBusy(false); }
  }

  const confirm = () => Alert.alert("Confirm this order?", `${o?.customer.name} agreed to take ${o?.items.reduce((n, i) => n + i.quantity, 0)} item(s) for ${formatKes(o?.totalCents ?? 0)}. It then goes to the shop to be dispatched.`, [
    { text: "Not yet", style: "cancel" },
    { text: "Confirm", onPress: () => act(() => request((t) => api.confirmOrder(t, id)), () => Alert.alert("Confirmed", "The shop can dispatch it now.", [{ text: "OK", onPress: () => nav.goBack() }])) },
  ]);
  const reschedule = () => {
    const choice = callbackChoices()[pick];
    if (choice) act(() => request((t) => api.rescheduleOrder(t, id, choice.at.toISOString(), note.trim() || undefined)));
  };
  const cancel = () => Alert.alert("Cancel this order?", "The customer will not get it. This cannot be undone.", [
    { text: "Keep it", style: "cancel" },
    { text: "Cancel order", style: "destructive", onPress: () => act(() => request((t) => api.cancelTelesalesOrder(t, id, reason.trim())), () => nav.goBack()) },
  ]);
  async function askManager() {
    setBusy(true);
    try { await request((t) => api.requestDuplicateApproval(t, id)); await load(); } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  }

  const waiting = !!o && o.status === "awaiting_dispatch" && !o.confirmed;
  const dup = (o?.duplicates.length ?? 0) > 0;
  const approval = o?.duplicateApproval ?? null;
  const blockedByDuplicate = dup && !o?.mayOverrideDuplicates && approval?.status !== "approved";

  return (
    <Page eyebrow="Confirm order" title={o ? o.number : "Order"} onBack={() => nav.goBack()} error={error} onRefresh={load}>
      {o ? (
        <>
          <Card>
            <View style={row.between}>
              <Text style={[text.title, { flex: 1 }]}>{o.customer.name}</Text>
              {waiting ? <CountdownPill confirmBy={o.confirmBy} serverTime={o.serverTime} fetchedAt={fetchedAt.current} now={now} /> : <Pill text={o.confirmed ? "Confirmed" : o.status.replace(/_/g, " ")} />}
            </View>
            <Text style={text.sub}>{o.customer.phone ?? "No phone"}{o.customer.city ? ` · ${o.customer.city}` : ""}</Text>
            {o.customerRisk.prepayRequired ? <Text style={[text.sub, { marginTop: 4 }]}>This customer has to prepay.</Text> : null}
            {waiting ? <ContactButtons phone={o.customer.phone} /> : null}
          </Card>

          {dup ? (
            <Card>
              <Text style={text.title}>This phone number has another order</Text>
              {o.duplicates.map((d) => <Text key={d.orderId} style={text.sub}>{d.number} · {d.status.replace(/_/g, " ")} · {formatKes(d.totalCents)}</Text>)}
              {approval?.status === "pending" ? <Text style={[text.sub, { marginTop: 8 }]}>Waiting for a manager to approve…</Text> : null}
              {approval?.status === "approved" ? <Text style={[text.sub, { marginTop: 8 }]}>A manager approved confirming this order.</Text> : null}
              {approval?.status === "rejected" ? <Text style={[text.sub, { marginTop: 8 }]}>A manager declined{approval.reviewNote ? `: ${approval.reviewNote}` : "."} Cancel it, or call the customer again.</Text> : null}
              {waiting && blockedByDuplicate && (!approval || approval.status === "rejected" || approval.status === "cancelled") ? <PrimaryButton label="Ask a manager to approve" onPress={askManager} loading={busy} disabled={offline} /> : null}
            </Card>
          ) : null}

          <Card>
            {o.items.map((i, k) => (
              <View key={k} style={[row.between, { marginBottom: 4 }]}>
                <Text style={[text.sub, { flex: 1 }]}>{i.quantity} × {i.name}</Text>
                <Text style={text.sub}>{formatKes(i.lineTotalCents)}</Text>
              </View>
            ))}
            <View style={row.between}><Text style={text.sub}>Delivery</Text><Text style={text.sub}>{formatKes(o.deliveryFeeCents)}</Text></View>
            <View style={[row.between, { marginTop: 6 }]}><Text style={text.title}>Customer pays on delivery</Text><Text style={text.title}>{formatKes(o.totalCents)}</Text></View>
            {o.notes ? <Text style={[text.sub, { marginTop: 6 }]}>Note: {o.notes}</Text> : null}
          </Card>

          {waiting ? (
            <>
              {mode === "none" ? (
                <View style={{ marginHorizontal: 16 }}>
                  <PrimaryButton label="Confirm order" onPress={confirm} loading={busy} disabled={offline || blockedByDuplicate} />
                  <PrimaryButton variant="ghost" label="Customer wants a later call" onPress={() => setMode("reschedule")} disabled={offline} />
                  <PrimaryButton variant="ghost" label="Customer does not want it" onPress={() => setMode("cancel")} disabled={offline} />
                </View>
              ) : null}
              {mode === "reschedule" ? (
                <Card>
                  <Text style={text.title}>Call back when?</Text>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", marginTop: 8 }}>
                    {callbackChoices().map((c, k) => <Chip key={c.label} label={c.label} active={pick === k} onPress={() => setPick(k)} />)}
                  </View>
                  <Field label="Note (optional)" value={note} onChangeText={setNote} />
                  <PrimaryButton label="Save call-back time" onPress={reschedule} loading={busy} disabled={offline} />
                  <PrimaryButton variant="ghost" label="Back" onPress={() => setMode("none")} />
                </Card>
              ) : null}
              {mode === "cancel" ? (
                <Card>
                  <Field label="Why is it cancelled? (required)" value={reason} onChangeText={setReason} />
                  <PrimaryButton label="Cancel order" onPress={cancel} loading={busy} disabled={reason.trim().length < 3 || offline} />
                  <PrimaryButton variant="ghost" label="Back" onPress={() => setMode("none")} />
                </Card>
              ) : null}
            </>
          ) : null}

          {o.history.length ? (
            <Card>
              <Text style={text.title}>History</Text>
              {o.history.slice(0, 5).map((h, k) => <Text key={k} style={text.sub}>{h.note ?? h.status.replace(/_/g, " ")}{h.by ? ` · ${h.by}` : ""}</Text>)}
            </Card>
          ) : null}
        </>
      ) : null}
    </Page>
  );
}
