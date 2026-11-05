import { useFocusEffect, useNavigation } from "@react-navigation/native";
import React, { useCallback, useState } from "react";
import { Alert, Pressable, Text, View } from "react-native";
import { api } from "../../api";
import type { AttendanceToday } from "../../api/typesV11";
import { useAuth } from "../../auth/AuthContext";
import { Card, PrimaryButton, row, text } from "../../components/ui";
import { colors } from "../../theme";
import { Field, Page, errText } from "./common";

const time = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString("en-KE", { hour: "2-digit", minute: "2-digit" }) : "—");

export default function AttendanceScreen() {
  const nav = useNavigation<any>();
  const { request, offline } = useAuth();
  const [a, setA] = useState<AttendanceToday | null>(null);
  const [dispatched, setDispatched] = useState(false);
  const [nairobi, setNairobi] = useState(false);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setA(await request((t) => api.attendanceToday(t))); setError(null); } catch (e) { setError(errText(e)); }
  }, [request]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const g = a?.gate ?? null;
  async function run(fn: () => Promise<AttendanceToday>) {
    setBusy(true);
    try { setA(await fn()); setError(null); setDispatched(false); setNairobi(false); setNotes(""); } catch (e) { setError(errText(e)); load(); } finally { setBusy(false); }
  }
  const clockIn = () => Alert.alert("Clock in?", "This records your start time for today.", [
    { text: "Cancel", style: "cancel" }, { text: "Clock in", onPress: () => run(() => request((t) => api.clockIn(t))) }]);
  const needReason = !!g?.reasonRequired && !notes.trim();
  const ready = (!g?.canConfirmDispatched || dispatched) && (!g?.canConfirmNairobi || nairobi) && !needReason;

  return (
    <Page eyebrow="Staff" title="Attendance" onBack={() => nav.goBack()} error={error} onRefresh={load}>
      {a ? (
        <>
          <Card>
            <Text style={text.title}>{a.status === "not_started" ? "Not clocked in" : a.status === "clocked_in" ? "On shift" : "Shift finished"}</Text>
            <View style={[row.between, { marginTop: 6 }]}><Text style={text.sub}>In {time(a.clockInAt)}</Text><Text style={text.sub}>Out {time(a.clockOutAt)}</Text></View>
          </Card>
          {a.status === "not_started" ? <View style={{ marginHorizontal: 16 }}><PrimaryButton label="Clock in" onPress={clockIn} loading={busy} disabled={offline} /></View> : null}
          {a.status === "clocked_in" ? (
            <Card>
              <Text style={text.title}>Before you clock out</Text>
              {g && (g.undispatchedOrders || g.nairobiUnpaid || g.custodyOpen || g.unmatchedPayments) ? (
                <Text style={text.sub}>
                  {[g.undispatchedOrders && `${g.undispatchedOrders} orders not dispatched`, g.nairobiUnpaid && `${g.nairobiUnpaid} Nairobi orders unpaid`, g.custodyOpen && `${g.custodyOpen} items in custody`, g.unmatchedPayments && `${g.unmatchedPayments} unmatched payments`].filter(Boolean).join(" · ")}
                </Text>
              ) : <Text style={text.sub}>Nothing is open.</Text>}
              {g?.blocked ? <Text style={{ color: colors.redText, marginTop: 6 }}>Clocking out is blocked until this is dealt with.</Text> : null}
              {g?.canConfirmDispatched ? <Check label="I confirm every order is dispatched" on={dispatched} onPress={() => setDispatched(!dispatched)} /> : null}
              {g?.canConfirmNairobi ? <Check label="I confirm Nairobi orders are reconciled" on={nairobi} onPress={() => setNairobi(!nairobi)} /> : null}
              {g?.reasonRequired || notes ? <Field label={g?.reasonRequired ? "Handover note (required)" : "Handover note"} value={notes} onChangeText={setNotes} multiline /> : <Field label="Handover note (optional)" value={notes} onChangeText={setNotes} multiline />}
              <PrimaryButton label="Clock out" loading={busy} disabled={!ready || !!g?.blocked || offline}
                onPress={() => run(() => request((t) => api.clockOut(t, { confirmAllDispatched: g?.canConfirmDispatched ? dispatched : undefined, confirmNairobiReconciled: g?.canConfirmNairobi ? nairobi : undefined, handoverNotes: notes.trim() || undefined })))} />
            </Card>
          ) : null}
        </>
      ) : null}
    </Page>
  );
}

function Check({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="checkbox" accessibilityState={{ checked: on }} style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 48, marginTop: 6 }}>
      <View style={{ width: 26, height: 26, borderRadius: 6, borderWidth: 1.5, borderColor: colors.ink, alignItems: "center", justifyContent: "center", backgroundColor: on ? colors.ink : "transparent" }}>{on ? <Text style={{ color: colors.paper }}>✓</Text> : null}</View>
      <Text style={[text.title, { flex: 1 }]}>{label}</Text>
    </Pressable>
  );
}
