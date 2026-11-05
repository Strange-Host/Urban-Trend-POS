import AsyncStorage from "@react-native-async-storage/async-storage";
import { useNavigation, useRoute } from "@react-navigation/native";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { api } from "../../api";
import type { StockTakeProduct } from "../../api/typesV11";
import { useAuth } from "../../auth/AuthContext";
import { Card, PrimaryButton, row, text } from "../../components/ui";
import { MIN_TOUCH, colors, radius } from "../../theme";
import { type LocalLine, draftKey, markSaved, mergeDraft, pendingBatches, summarize } from "../../lib/stockTake";
import { Field, Page, errText } from "./common";

// What the server usually asks to be approved. The server is the judge; this only warns while counting.
const USUAL_LIMIT_UNITS = 10;

export default function StockTakeCountScreen() {
  const nav = useNavigation<any>();
  const params = useRoute<any>().params as { id: number; barcode?: string; nonce?: number };
  const { request, user, offline } = useAuth();
  const [lines, setLines] = useState<LocalLine[]>([]);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<StockTakeProduct[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<"saved" | "saving" | "unsaved">("saved");
  const [busy, setBusy] = useState(false);
  const linesRef = useRef<LocalLine[]>([]);
  const key = user ? draftKey(user.id, params.id) : null;
  linesRef.current = lines;

  const persistLocal = useCallback((next: LocalLine[]) => {
    if (key) AsyncStorage.setItem(key, JSON.stringify(next)).catch(() => {}); // counts survive an app kill or a dead signal
  }, [key]);
  const update = useCallback((fn: (l: LocalLine[]) => LocalLine[]) => {
    setLines((prev) => { const next = fn(prev); linesRef.current = next; persistLocal(next); return next; });
    setSaved("unsaved");
  }, [persistLocal]);

  // open: server draft merged with whatever the phone still holds
  useEffect(() => {
    (async () => {
      let local: LocalLine[] = [];
      try { if (key) local = JSON.parse((await AsyncStorage.getItem(key)) ?? "[]"); } catch { local = []; }
      try {
        const d = await request((t) => api.stockTake(t, params.id));
        const merged = mergeDraft(d.lines, local);
        setLines(merged); linesRef.current = merged; persistLocal(merged);
        setSaved(merged.some((l) => l.dirty) ? "unsaved" : "saved");
      } catch (e) { setLines(local); setError(errText(e)); }
    })();
  }, [params.id, key, request, persistLocal]);

  const flush = useCallback(async (): Promise<boolean> => {
    const batches = pendingBatches(linesRef.current);
    if (batches.length === 0) { setSaved("saved"); return true; }
    setSaved("saving");
    try {
      for (const b of batches) {
        await request((t) => api.saveStockTakeLines(t, params.id, b));
        linesRef.current = markSaved(linesRef.current, b);
        setLines(linesRef.current); persistLocal(linesRef.current);
      }
      setSaved(pendingBatches(linesRef.current).length ? "unsaved" : "saved");
      setError(null);
      return true;
    } catch (e) { setSaved("unsaved"); setError(errText(e)); return false; }
  }, [request, params.id, persistLocal]);

  useEffect(() => { // autosave a moment after the last tap
    if (saved !== "unsaved" || offline) return;
    const h = setTimeout(() => { flush(); }, 1500);
    return () => clearTimeout(h);
  }, [lines, saved, offline, flush]);

  const add = useCallback((p: StockTakeProduct) => {
    update((prev) => prev.some((l) => l.productId === p.productId)
      ? prev.map((l) => (l.productId === p.productId ? { ...l, countedQty: l.countedQty + 1, dirty: true } : l))
      : [{ productId: p.productId, name: p.name, sku: p.sku, barcode: p.barcode, countedQty: 1, systemQty: p.systemQty, dirty: true }, ...prev]);
    setQ(""); setFound([]);
  }, [update]);

  // a barcode coming back from the camera: look it up inside this sheet's scope
  useEffect(() => {
    if (!params.barcode) return;
    request((t) => api.stockTakeProducts(t, params.id, { barcode: params.barcode }))
      .then((r) => { if (r[0]) add(r[0]); else setError("That barcode is not in this count."); })
      .catch((e) => setError(errText(e)));
  }, [params.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (q.trim().length < 2) { setFound([]); return; }
    const h = setTimeout(() => request((t) => api.stockTakeProducts(t, params.id, { q: q.trim() })).then(setFound).catch(() => {}), 250);
    return () => clearTimeout(h);
  }, [q, params.id, request]);

  const setQty = (id: number, n: number) => update((prev) => prev.map((l) => (l.productId === id ? { ...l, countedQty: Math.max(0, n), dirty: true } : l)));
  const sum = summarize(lines, USUAL_LIMIT_UNITS);

  async function submit() {
    if (!(await flush())) return;
    Alert.alert("Submit this count?", `${lines.length} products counted. Small differences update stock now; large ones wait for approval. This cannot be undone.`, [
      { text: "Keep counting", style: "cancel" },
      { text: "Submit", onPress: async () => {
        setBusy(true);
        try {
          const r = await request((t) => api.submitStockTake(t, params.id));
          if (key) AsyncStorage.removeItem(key).catch(() => {});
          Alert.alert(r.status === "applied" ? "Stock updated" : "Sent for approval",
            `${r.applied.length} applied${r.pendingApproval.length ? `, ${r.pendingApproval.length} waiting for approval` : ""}${r.notCountedCount ? `. ${r.notCountedCount} products were not counted and were left alone.` : "."}`);
          nav.replace("StockTakeDetail", { id: params.id });
        } catch (e) { setError(errText(e)); } finally { setBusy(false); }
      } },
    ]);
  }

  return (
    <Page eyebrow="Stock-take" title="Count" onBack={() => { flush(); nav.goBack(); }} error={error}
      footer={<View style={s.foot}><Text style={text.sub}>{saved === "saved" ? "Saved" : saved === "saving" ? "Saving…" : "Not saved yet · kept on this phone"}</Text>
        <PrimaryButton label={`Submit (${lines.length})`} onPress={submit} loading={busy} disabled={lines.length === 0 || offline} /></View>}>
      <Card>
        <View style={row.between}>
          <View style={{ flex: 1 }}><Field label="Find by name or SKU" value={q} onChangeText={setQ} /></View>
          <Pressable style={s.scan} accessibilityRole="button" accessibilityLabel="Scan barcode"
            onPress={() => nav.navigate("Scan", { returnTo: { name: "StockTakeCount", params: { id: params.id } } })}><Text style={s.scanText}>Scan</Text></Pressable>
        </View>
        {found.map((p) => (
          <Pressable key={p.productId} onPress={() => add(p)} style={s.hit} accessibilityRole="button">
            <Text style={text.title}>{p.name}</Text><Text style={text.sub}>{p.sku} · system {p.systemQty}</Text>
          </Pressable>
        ))}
      </Card>
      {lines.length ? <Text style={[text.sub, { marginHorizontal: 16, marginTop: 8 }]}>{sum.counted} counted · {sum.unitsShort} short · {sum.unitsOver} over{sum.needsApproval ? ` · ${sum.needsApproval} will need approval` : ""}</Text> : null}
      {lines.map((l) => {
        const v = l.countedQty - l.systemQty;
        return (
          <Card key={l.productId}>
            <Text style={text.title} numberOfLines={2}>{l.name}</Text>
            <Text style={text.sub}>{l.sku} · system {l.systemQty}{l.dirty ? " · unsaved" : ""}</Text>
            <View style={[row.between, { marginTop: 8 }]}>
              <Step label="−" onPress={() => setQty(l.productId, l.countedQty - 1)} />
              <TextInput style={s.qty} keyboardType="number-pad" value={String(l.countedQty)} selectTextOnFocus
                onChangeText={(t) => setQty(l.productId, parseInt(t, 10) || 0)} />
              <Step label="+" onPress={() => setQty(l.productId, l.countedQty + 1)} />
            </View>
            {v !== 0 ? <Text style={{ textAlign: "center", marginTop: 6, color: v < 0 ? colors.redText : colors.ink, fontWeight: "600" }}>{v > 0 ? "+" : ""}{v} vs system</Text> : null}
          </Card>
        );
      })}
    </Page>
  );
}

function Step({ label, onPress }: { label: string; onPress: () => void }) {
  return <Pressable onPress={onPress} accessibilityRole="button" style={s.step}><Text style={s.stepText}>{label}</Text></Pressable>;
}
const s = StyleSheet.create({
  foot: { paddingHorizontal: 16, paddingBottom: 12, paddingTop: 6, borderTopWidth: 1, borderColor: colors.line, backgroundColor: colors.paper },
  scan: { minHeight: MIN_TOUCH, minWidth: 64, marginTop: 24, borderRadius: radius.button, backgroundColor: colors.ink, alignItems: "center", justifyContent: "center" },
  scanText: { color: colors.paper, fontWeight: "700" },
  hit: { minHeight: MIN_TOUCH, paddingVertical: 8, borderTopWidth: 1, borderColor: colors.line, marginTop: 6 },
  step: { width: 56, height: 56, borderRadius: radius.button, borderWidth: 1, borderColor: colors.ink, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface },
  stepText: { fontSize: 28, fontWeight: "600", color: colors.ink },
  qty: { flex: 1, textAlign: "center", fontSize: 30, fontWeight: "700", color: colors.text, minHeight: MIN_TOUCH },
});
