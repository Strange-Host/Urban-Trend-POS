import { useNavigation, useRoute } from "@react-navigation/native";
import React, { useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { api } from "../api";
import { isApiError } from "../api/errors";
import type { AdjustReason, StockItem } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { Header } from "../components/Header";
import { Banner, Card, Chip, PrimaryButton, row, text } from "../components/ui";
import { adjustReasons } from "../lib/labels";
import { MIN_TOUCH, colors, radius } from "../theme";

export default function AdjustScreen() {
  const nav = useNavigation<any>();
  const { item } = useRoute<any>().params as { item: StockItem };
  const { request, offline } = useAuth();
  const [delta, setDelta] = useState(0);
  const [raw, setRaw] = useState("0");
  const [reason, setReason] = useState<AdjustReason | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (n: number) => {
    setDelta(n);
    setRaw(String(n));
  };
  const after = item.available + delta;
  const invalid = delta === 0 || after < 0 || !reason || (reason === "other" && !note.trim());

  async function submit() {
    if (!reason || invalid) return;
    setBusy(true);
    setError(null);
    try {
      const res = await request((t) => api.stockAdjust(t, { productId: item.id, delta, reason, note: note.trim() || undefined }));
      Alert.alert(
        res.applied ? "Stock updated" : "Sent for approval",
        res.applied
          ? `${item.name} is now ${res.newAvailable ?? after}.`
          : "This change is above the limit, so the owner has to approve it before stock changes.",
      );
      nav.goBack();
    } catch (e) {
      setError(isApiError(e) ? (e.code === "NETWORK" ? "No connection. Adjusting stock needs internet." : e.message) : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.paper }}>
      <Header eyebrow="Adjust stock" title={item.name} onBack={() => nav.goBack()} />
      {offline ? <Banner text="Offline · adjusting needs a connection." /> : null}
      {error ? <Banner text={error} /> : null}
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 32 }}>
        <Card>
          <Text style={text.sub}>Available now {item.available}</Text>
          <View style={[row.between, { marginTop: 10 }]}>
            <Step label="−" onPress={() => set(delta - 1)} />
            <TextInput
              style={s.qty}
              value={raw}
              keyboardType="numbers-and-punctuation"
              onChangeText={(v) => {
                setRaw(v);
                const n = parseInt(v, 10);
                setDelta(Number.isFinite(n) ? n : 0);
              }}
              selectTextOnFocus
            />
            <Step label="+" onPress={() => set(delta + 1)} />
          </View>
          <Text style={[text.title, { textAlign: "center", marginTop: 10, color: after < 0 ? colors.redText : colors.text }]}>
            {item.available} → {after}
          </Text>
        </Card>
        <Card>
          <Text style={text.title}>Reason</Text>
          <View style={s.chips}>
            {adjustReasons.map((r) => (
              <Chip key={r.key} label={r.label} active={reason === r.key} onPress={() => setReason(r.key)} />
            ))}
          </View>
          <TextInput
            style={s.note}
            value={note}
            onChangeText={setNote}
            placeholder={reason === "other" ? "Note (required)" : "Note (optional)"}
            placeholderTextColor={colors.muted}
            multiline
          />
        </Card>
        <View style={{ marginHorizontal: 16 }}>
          <PrimaryButton label="Submit adjustment" onPress={submit} loading={busy} disabled={invalid || offline} />
        </View>
      </ScrollView>
    </View>
  );
}

function Step({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={s.step}>
      <Text style={s.stepText}>{label}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  step: { width: 56, height: 56, borderRadius: radius.button, borderWidth: 1, borderColor: colors.ink, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface },
  stepText: { fontSize: 28, fontWeight: "600", color: colors.ink },
  qty: { flex: 1, textAlign: "center", fontSize: 32, fontWeight: "700", color: colors.text, minHeight: MIN_TOUCH },
  chips: { flexDirection: "row", flexWrap: "wrap", marginTop: 10, rowGap: 8 },
  note: { marginTop: 12, minHeight: MIN_TOUCH * 1.5, borderWidth: 1, borderColor: colors.line, borderRadius: radius.button, padding: 12, fontSize: 15, textAlignVertical: "top", color: colors.text, backgroundColor: colors.surface },
});
