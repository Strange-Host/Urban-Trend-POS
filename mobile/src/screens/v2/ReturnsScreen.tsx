import { useFocusEffect, useNavigation } from "@react-navigation/native";
import React, { useCallback, useEffect, useState } from "react";
import { Alert, Text, View } from "react-native";
import { api } from "../../api";
import type { ReturnCondition, ReturnDecisionKind, ReturnItem, ReturnReason } from "../../api/typesV2";
import { useAuth } from "../../auth/AuthContext";
import { Card, Chip, Empty, Pill, PrimaryButton, row, text } from "../../components/ui";
import { formatKes, timeAgo } from "../../lib/format";
import { can } from "../../lib/permissions";
import { useSecureScreen } from "../../lib/secureScreen";
import { DECISION_LABEL, REASON_LABEL } from "../../lib/telesales";
import { Field, Page, errText } from "../v11/common";

type Tab = "awaiting" | "decided" | "receive";

export default function ReturnsScreen() {
  const nav = useNavigation<any>();
  const { request, user, offline } = useAuth();
  useSecureScreen("returns");
  const [tab, setTab] = useState<Tab>("awaiting");
  const [items, setItems] = useState<ReturnItem[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // receiving
  const [q, setQ] = useState("");
  const [found, setFound] = useState<ReturnItem[]>([]);
  const [chosen, setChosen] = useState<ReturnItem | null>(null);
  const [reason, setReason] = useState<ReturnReason | null>(null);
  const [condition, setCondition] = useState<ReturnCondition | null>(null);
  const [note, setNote] = useState("");

  const canRestock = can(user, "orders.inspect");
  const isOwner = user?.role === "admin";

  const load = useCallback(async (cursor?: string) => {
    if (tab === "receive") return;
    try {
      const p = await request((t) => api.returns(t, { status: tab, cursor }));
      setItems((prev) => (cursor ? [...prev, ...p.items] : p.items)); setNext(p.nextCursor); setError(null);
    } catch (e) { setError(errText(e)); }
  }, [request, tab]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  useEffect(() => {
    if (tab !== "receive" || q.trim().length < 2) { setFound([]); return; }
    const h = setTimeout(() => request((t) => api.findReturnable(t, q.trim())).then(setFound).catch((e) => setError(errText(e))), 300);
    return () => clearTimeout(h);
  }, [q, tab, request]);

  async function receive() {
    if (!chosen || !reason || !condition) return;
    setBusy(true); setError(null);
    try {
      await request((t) => api.receiveReturn(t, { orderId: chosen.id, reasonCode: reason, condition, note: note.trim() || undefined }));
      Alert.alert("Return received", `${chosen.number} now waits for a decision. Stock has not changed yet.`);
      setChosen(null); setReason(null); setCondition(null); setNote(""); setQ(""); setFound([]); setTab("awaiting");
    } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  }

  function decide(r: ReturnItem, d: ReturnDecisionKind) {
    const msg = d === "restock" ? "The units go back on sale." : d === "write_off" ? "The units are written off and stay out of stock." : "The units are disposed of and stay out of stock.";
    Alert.alert(`${DECISION_LABEL[d]}: ${r.number}?`, `${msg} This cannot be undone.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Confirm", onPress: async () => {
        try { await request((t) => api.decideReturn(t, r.id, d)); setError(null); load(); } catch (e) { setError(errText(e)); load(); }
      } },
    ]);
  }

  return (
    <Page eyebrow="Orders" title="Returns" onBack={() => nav.goBack()} error={error} onRefresh={() => load()}>
      <View style={{ flexDirection: "row", paddingHorizontal: 16, paddingTop: 10, flexWrap: "wrap" }}>
        <Chip label="Awaiting decision" active={tab === "awaiting"} onPress={() => setTab("awaiting")} />
        <Chip label="Decided" active={tab === "decided"} onPress={() => setTab("decided")} />
        <Chip label="Receive a return" active={tab === "receive"} onPress={() => setTab("receive")} />
      </View>

      {tab === "receive" ? (
        chosen ? (
          <Card>
            <Text style={text.title}>{chosen.number} · {chosen.customer.name}</Text>
            <Text style={text.sub}>{chosen.itemCount} items · {formatKes(chosen.totalCents)}</Text>
            <Text style={[text.title, { marginTop: 12 }]}>Why did it come back?</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", marginTop: 6 }}>
              {(Object.keys(REASON_LABEL) as ReturnReason[]).map((r) => <Chip key={r} label={REASON_LABEL[r]} active={reason === r} onPress={() => setReason(r)} />)}
            </View>
            <Text style={[text.title, { marginTop: 12 }]}>What condition is it in?</Text>
            <View style={{ flexDirection: "row", marginTop: 6 }}>
              <Chip label="Good, unused" active={condition === "good"} onPress={() => setCondition("good")} />
              <Chip label="Damaged" active={condition === "damaged"} onPress={() => setCondition("damaged")} />
            </View>
            <Field label="Note (optional)" value={note} onChangeText={setNote} />
            <PrimaryButton label="Receive parcel" onPress={receive} loading={busy} disabled={!reason || !condition || offline} />
            <PrimaryButton variant="ghost" label="Pick another order" onPress={() => setChosen(null)} />
          </Card>
        ) : (
          <Card>
            <Field label="Find the order: number, customer name or phone" value={q} onChangeText={setQ} autoCapitalize="none" />
            {q.trim().length >= 2 && found.length === 0 ? <Text style={[text.sub, { marginTop: 8 }]}>No dispatched order matches.</Text> : null}
            {found.map((r) => (
              <Card key={r.id} onPress={() => setChosen(r)}>
                <Text style={text.title}>{r.number} · {r.customer.name}</Text>
                <Text style={text.sub}>{r.customer.phone ?? ""} · {formatKes(r.totalCents)}</Text>
              </Card>
            ))}
          </Card>
        )
      ) : (
        <>
          {items.length === 0 ? <Empty title={tab === "awaiting" ? "Nothing waiting for a decision" : "No decided returns yet"} /> : null}
          {items.map((r) => (
            <Card key={r.id}>
              <View style={row.between}>
                <Text style={[text.title, { flex: 1 }]}>{r.number} · {r.customer.name}</Text>
                {r.decision ? <Pill text={DECISION_LABEL[r.decision]} tone={r.decision === "restock" ? "amber" : "red"} /> : <Pill text="Needs a decision" />}
              </View>
              <Text style={text.sub}>{r.itemCount} items · {formatKes(r.totalCents)}{r.reasonCode ? ` · ${REASON_LABEL[r.reasonCode]}` : ""}</Text>
              <Text style={text.sub}>{r.condition ? `${r.condition === "good" ? "Good" : "Damaged"} · ` : ""}{r.receivedBy ? `received by ${r.receivedBy} ` : ""}{r.receivedAt ? timeAgo(r.receivedAt) : ""}</Text>
              {r.note ? <Text style={text.sub}>“{r.note}”</Text> : null}
              {!r.decision && (canRestock || isOwner) ? (
                <View style={{ marginTop: 8 }}>
                  {canRestock && r.status !== "returned_damaged" ? <PrimaryButton label="Put back on sale" onPress={() => decide(r, "restock")} disabled={offline} /> : null}
                  {isOwner ? <PrimaryButton variant="ghost" label="Write off" onPress={() => decide(r, "write_off")} disabled={offline} /> : null}
                  {isOwner ? <PrimaryButton variant="ghost" label="Dispose" onPress={() => decide(r, "dispose")} disabled={offline} /> : null}
                </View>
              ) : null}
              {!r.decision && !canRestock && !isOwner ? <Text style={[text.sub, { marginTop: 6 }]}>The owner or a manager decides what happens to it.</Text> : null}
            </Card>
          ))}
          {next ? <View style={{ marginHorizontal: 16 }}><PrimaryButton variant="ghost" label="Load more" onPress={() => load(next)} /></View> : null}
        </>
      )}
    </Page>
  );
}
