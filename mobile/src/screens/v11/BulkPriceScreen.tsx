import { useNavigation } from "@react-navigation/native";
import React, { useCallback, useEffect, useState } from "react";
import { Alert, ScrollView, Text, View } from "react-native";
import { api } from "../../api";
import { isApiError } from "../../api/errors";
import type { BulkBatch, BulkChange, BulkMode, BulkPreview, Category } from "../../api/typesV11";
import { useAuth } from "../../auth/AuthContext";
import { Card, Chip, Pill, PrimaryButton, row, text } from "../../components/ui";
import { describeChange } from "../../lib/bulkPrice";
import { authenticate } from "../../lib/biometric";
import { formatKes, timeAgo } from "../../lib/format";
import { parseKesToCents } from "../../lib/money";
import { useSecureScreen } from "../../lib/secureScreen";
import { colors } from "../../theme";
import { Field, Page, errText } from "./common";

const SKIP: Record<string, string> = { PRICE_NOT_POSITIVE: "would be zero or less", UNCHANGED: "no change", PRICE_CHANGED_SINCE: "repriced since" };

export default function BulkPriceScreen() {
  const nav = useNavigation<any>();
  const { request, offline } = useAuth();
  useSecureScreen("bulk");
  const [cats, setCats] = useState<Category[]>([]);
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [mode, setMode] = useState<BulkMode>("percent");
  const [raw, setRaw] = useState("");
  const [sign, setSign] = useState<1 | -1>(1);
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<BulkPreview | null>(null);
  const [batches, setBatches] = useState<BulkBatch[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // percent: "7.5" -> 7.5 ; fixed: shillings -> cents. Sign comes from the +/- chips so nobody types a minus by accident.
  const magnitude = mode === "percent" ? (/^\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw) : null) : parseKesToCents(raw);
  const change: BulkChange | null = categoryId !== null && magnitude !== null && magnitude > 0 ? { categoryId, mode, value: sign * magnitude } : null;

  const loadBatches = useCallback(() => request((t) => api.bulkBatches(t)).then((p) => setBatches(p.items)).catch(() => {}), [request]);
  useEffect(() => {
    request((t) => api.categories(t)).then(setCats).catch(() => {});
    loadBatches();
  }, [request, loadBatches]);
  useEffect(() => setPreview(null), [categoryId, mode, raw, sign]); // any edit invalidates the preview

  async function runPreview() {
    if (!change) return;
    setBusy(true); setError(null);
    try { setPreview(await request((t) => api.bulkPreview(t, change))); } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  }

  async function apply() {
    if (!change || !preview || !reason.trim()) return;
    if (!(await authenticate("Confirm price change"))) { setError("Confirmation cancelled. Nothing was changed."); return; }
    setBusy(true); setError(null);
    try {
      const r = await request((t) => api.bulkApply(t, change, reason.trim(), preview.fingerprint));
      Alert.alert("Prices changed", `${r.count} products updated. You can revert this below.`);
      setPreview(null); setReason(""); setRaw("");
      loadBatches();
    } catch (e) {
      setError(errText(e));
      if (isApiError(e) && e.code === "PREVIEW_STALE") runPreview();
    } finally { setBusy(false); }
  }

  function revert(b: BulkBatch) {
    Alert.alert("Revert this change?", "Products repriced since are left alone. The revert is recorded as a new change.", [
      { text: "Cancel", style: "cancel" },
      { text: "Revert", style: "destructive", onPress: async () => {
        if (!(await authenticate("Confirm revert"))) return;
        try {
          const r = await request((t) => api.bulkRevert(t, b.id, "Reverted from phone"));
          Alert.alert("Reverted", `${r.count} products restored${r.skipped.length ? `, ${r.skipped.length} left as they were (repriced since)` : ""}.`);
          setError(null); loadBatches();
        } catch (e) { setError(errText(e)); }
      } },
    ]);
  }

  return (
    <Page eyebrow="Catalog" title="Bulk price change" onBack={() => nav.goBack()} error={error}>
      <Card>
        <Text style={text.title}>Category</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 8 }}>
          {cats.filter((c) => c.isActive).map((c) => <Chip key={c.id} label={`${c.name} (${c.productCount})`} active={categoryId === c.id} onPress={() => setCategoryId(c.id)} />)}
        </ScrollView>
        <Text style={text.sub}>Only products directly in the category are changed.</Text>
      </Card>
      <Card>
        <View style={{ flexDirection: "row" }}>
          <Chip label="Percent" active={mode === "percent"} onPress={() => setMode("percent")} />
          <Chip label="Fixed KES" active={mode === "fixed"} onPress={() => setMode("fixed")} />
        </View>
        <View style={{ flexDirection: "row", marginTop: 8 }}>
          <Chip label="Increase" active={sign === 1} onPress={() => setSign(1)} />
          <Chip label="Decrease" active={sign === -1} onPress={() => setSign(-1)} />
        </View>
        <Field label={mode === "percent" ? "Percent" : "Amount (KES)"} value={raw} onChangeText={setRaw} keyboardType="decimal-pad" />
        <PrimaryButton label="Preview" onPress={runPreview} disabled={!change || offline} loading={busy && !preview} />
      </Card>
      {preview ? (
        <>
          <Card>
            <Text style={text.title}>{preview.count} products will change · {change ? describeChange(change.mode, change.value) : ""}</Text>
            {preview.skippedCount ? <Text style={text.sub}>{preview.skippedCount} skipped: {preview.skipped.slice(0, 3).map((k) => `${k.name} (${SKIP[k.reason] ?? k.reason})`).join(", ")}{preview.skippedCount > 3 ? "…" : ""}</Text> : null}
          </Card>
          {preview.items.map((i) => (
            <Card key={i.productId}>
              <Text style={text.title} numberOfLines={1}>{i.name}</Text>
              <View style={[row.between, { marginTop: 4 }]}>
                <Text style={text.sub}>{formatKes(i.oldPriceCents)} → {formatKes(i.newPriceCents)}</Text>
                <Text style={{ color: i.deltaCents < 0 ? colors.redText : colors.ink, fontWeight: "600" }}>{i.deltaCents > 0 ? "+" : ""}{formatKes(i.deltaCents)}</Text>
              </View>
            </Card>
          ))}
          {preview.count > 0 ? (
            <Card>
              <Field label="Reason (required)" value={reason} onChangeText={setReason} />
              <PrimaryButton label="Apply to all (fingerprint or face)" onPress={apply} disabled={!reason.trim() || offline} loading={busy} />
            </Card>
          ) : null}
        </>
      ) : null}
      <Text style={[text.mono, { marginHorizontal: 16, marginTop: 20 }]}>Recent changes</Text>
      {batches.map((b) => (
        <Card key={b.id}>
          <View style={row.between}>
            <Text style={[text.title, { flex: 1 }]}>{b.categoryName ?? "—"} · {b.kind === "bulk_revert" ? "Revert" : describeChange(b.mode, b.value)}</Text>
            {b.revertedAt ? <Pill text="Reverted" /> : null}
          </View>
          <Text style={text.sub}>{b.productCount} products · {b.createdBy.name} · {timeAgo(b.createdAt)}</Text>
          {b.reason ? <Text style={text.sub}>“{b.reason}”</Text> : null}
          {b.kind === "bulk" && !b.revertedAt ? <PrimaryButton variant="ghost" label="Revert" onPress={() => revert(b)} disabled={offline} /> : null}
        </Card>
      ))}
    </Page>
  );
}
