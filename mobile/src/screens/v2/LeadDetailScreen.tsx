import { useNavigation, useRoute } from "@react-navigation/native";
import React, { useCallback, useEffect, useState } from "react";
import { Alert, Text, View } from "react-native";
import { api } from "../../api";
import { isApiError } from "../../api/errors";
import type { LeadDetail, LeadStatus } from "../../api/typesV2";
import { useAuth } from "../../auth/AuthContext";
import { Card, Chip, Pill, PrimaryButton, row, text } from "../../components/ui";
import { timeAgo } from "../../lib/format";
import { useSecureScreen } from "../../lib/secureScreen";
import { followUpIn } from "../../lib/telesales";
import { Field, Page, errText } from "../v11/common";
import { ContactButtons } from "./shared";
import { LEAD_LABEL } from "./MyLeadsScreen";

// The website's lead rules, so the buttons offered are exactly the moves the server allows from each status.
const NEXT: Record<LeadStatus, LeadStatus[]> = { new: ["contacted", "cancelled"], contacted: ["rescheduled", "cancelled"], rescheduled: ["contacted", "cancelled"], converted: [], cancelled: [] };
const OUTCOMES = ["Answered, interested", "No answer", "Phone busy or off", "Wrong number", "Asked to call later"];
const FOLLOW_UPS: [string, number][] = [["Tomorrow", 1], ["In 3 days", 3], ["Next week", 7]];

export default function LeadDetailScreen() {
  const nav = useNavigation<any>();
  const { id } = useRoute<any>().params as { id: number };
  const { request, offline } = useAuth();
  useSecureScreen("lead");
  const [l, setL] = useState<LeadDetail | null>(null);
  const [notes, setNotes] = useState("");
  const [custom, setCustom] = useState("");
  const [pickingDate, setPickingDate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { const d = await request((t) => api.lead(t, id)); setL(d); setNotes(d.notes ?? ""); setError(null); } catch (e) { setError(errText(e)); }
  }, [request, id]);
  useEffect(() => { load(); }, [load]);

  async function run<T>(fn: () => Promise<T>, after?: (r: T) => void) {
    setBusy(true); setError(null);
    try { const r = await fn(); after?.(r); } catch (e) { setError(errText(e)); if (isApiError(e) && e.code === "CONFLICT") load(); } finally { setBusy(false); }
  }
  const apply = (d: LeadDetail) => { setL(d); setNotes(d.notes ?? ""); };

  const move = (to: LeadStatus, followUpDate?: string) => run(() => request((t) => api.updateLead(t, id, { status: to, followUpDate })), (d) => { apply(d); setPickingDate(false); });
  const log = (type: "call" | "message" | "note", content: string) => run(() => request((t) => api.addLeadActivity(t, id, type, content)), (d) => { apply(d); setCustom(""); });

  async function convert(mergeIntoOrderId?: number) {
    setBusy(true); setError(null);
    try {
      const r = await request((t) => api.convertLead(t, id, { mergeIntoOrderId }));
      apply(r.lead);
      Alert.alert(r.merged ? "Added to the existing order" : "Order created", `${r.orderNumber} is ready for confirmation.`);
    } catch (e) {
      const d = isApiError(e) ? (e.details as { existingOrderId?: number; canMerge?: boolean } | undefined) : undefined;
      if (d?.existingOrderId) {
        Alert.alert("This number already has an order", "Add this lead's items to that order instead of creating a second one?", [
          { text: "Cancel", style: "cancel" },
          ...(d.canMerge === false ? [] : [{ text: "Add to existing order", onPress: () => convert(d.existingOrderId) }]),
        ]);
      } else setError(errText(e));
    } finally { setBusy(false); }
  }
  const confirmConvert = () => Alert.alert("Turn this lead into an order?", `${l?.name}${l?.interestedProduct?.name ? ` · ${l.interestedProduct.name}` : ""}`, [
    { text: "Not yet", style: "cancel" }, { text: "Create order", onPress: () => convert() }]);

  const open = !!l && l.status !== "converted" && l.status !== "cancelled";
  return (
    <Page eyebrow="Lead" title={l?.name ?? "Lead"} onBack={() => nav.goBack()} error={error} onRefresh={load}>
      {l ? (
        <>
          <Card>
            <View style={row.between}><Text style={[text.title, { flex: 1 }]}>{l.phone}</Text><Pill text={LEAD_LABEL[l.status]} tone={l.status === "cancelled" ? "red" : "amber"} /></View>
            <Text style={text.sub}>{l.source.replace(/_/g, " ")}{l.interestedProduct?.name ? ` · interested in ${l.interestedProduct.name}` : ""}</Text>
            {l.status === "rescheduled" && l.followUpDate ? <Text style={[text.sub, { marginTop: 4 }]}>Call back on {l.followUpDate}</Text> : null}
            {l.convertedOrderId ? <Text style={[text.sub, { marginTop: 4 }]}>Converted to an order.</Text> : null}
            {open ? <ContactButtons phone={l.phone} /> : null}
          </Card>

          {open ? (
            <Card>
              <Text style={text.title}>How did the call go?</Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", marginTop: 8 }}>
                {OUTCOMES.map((o) => <Chip key={o} label={o} onPress={() => !offline && log("call", o)} />)}
              </View>
              <Field label="Or write a note" value={custom} onChangeText={setCustom} />
              <PrimaryButton variant="ghost" label="Save note" onPress={() => log("note", custom.trim())} disabled={!custom.trim() || offline} loading={busy} />
            </Card>
          ) : null}

          {open ? (
            <Card>
              <Text style={text.title}>Move this lead</Text>
              {pickingDate ? (
                <>
                  <Text style={text.sub}>Call back when?</Text>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", marginTop: 8 }}>
                    {FOLLOW_UPS.map(([label, days]) => <Chip key={label} label={`${label} (${followUpIn(days)})`} onPress={() => move("rescheduled", followUpIn(days))} />)}
                  </View>
                  <PrimaryButton variant="ghost" label="Back" onPress={() => setPickingDate(false)} />
                </>
              ) : (
                <View style={{ marginTop: 6 }}>
                  {NEXT[l.status].map((to) => (
                    <PrimaryButton key={to} variant="ghost" label={to === "rescheduled" ? "Call back later…" : to === "cancelled" ? "Not interested (cancel)" : `Mark ${LEAD_LABEL[to].toLowerCase()}`}
                      disabled={offline || busy}
                      onPress={() => (to === "rescheduled" ? setPickingDate(true) : to === "cancelled" ? Alert.alert("Cancel this lead?", "A cancelled lead cannot be reopened from the phone.", [{ text: "Keep", style: "cancel" }, { text: "Cancel lead", style: "destructive", onPress: () => move("cancelled") }]) : move(to))} />
                  ))}
                  {l.status !== "new" ? <PrimaryButton label="Convert to order" onPress={confirmConvert} loading={busy} disabled={offline} /> : <Text style={text.sub}>Mark the lead contacted after your first call to convert it.</Text>}
                </View>
              )}
            </Card>
          ) : null}

          <Card>
            <Field label="Notes" value={notes} onChangeText={setNotes} multiline />
            <PrimaryButton variant="ghost" label="Save notes" onPress={() => run(() => request((t) => api.updateLead(t, id, { notes })), apply)} disabled={notes === (l.notes ?? "") || offline} loading={busy} />
          </Card>

          <Card>
            <Text style={text.title}>History</Text>
            {l.activities.length === 0 ? <Text style={text.sub}>Nothing recorded yet.</Text> : null}
            {l.activities.map((a) => (
              <View key={a.id} style={{ marginTop: 6 }}>
                <Text style={text.sub}>{a.type === "status_change" ? "Status" : a.type}{a.by ? ` · ${a.by}` : ""} · {timeAgo(a.at)}</Text>
                {a.content ? <Text style={text.sub}>{a.content}</Text> : null}
              </View>
            ))}
          </Card>
        </>
      ) : null}
    </Page>
  );
}
