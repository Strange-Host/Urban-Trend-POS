import { useNavigation } from "@react-navigation/native";
import React, { useCallback, useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { api } from "../../api";
import type { Category } from "../../api/typesV11";
import { useAuth } from "../../auth/AuthContext";
import { Card, Pill, PrimaryButton, row, text } from "../../components/ui";
import { MIN_TOUCH, colors, radius } from "../../theme";
import { Field, Page, errText } from "./common";

export default function CategoriesScreen() {
  const nav = useNavigation<any>();
  const { request, offline } = useAuth();
  const [cats, setCats] = useState<Category[]>([]);
  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setCats(await request((t) => api.categories(t, true))); setError(null); } catch (e) { setError(errText(e)); }
  }, [request]);
  useEffect(() => { load(); }, [load]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try { await fn(); setError(null); await load(); } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  }
  const move = (i: number, d: -1 | 1) => {
    const ids = cats.map((c) => c.id);
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    run(async () => setCats(await request((t) => api.reorderCategories(t, ids))));
  };

  return (
    <Page eyebrow="Catalog" title="Categories" onBack={() => nav.goBack()} error={error}>
      <Card>
        <Field label="New category" value={newName} onChangeText={setNewName} />
        <PrimaryButton label="Add category" disabled={!newName.trim() || offline} loading={busy}
          onPress={() => run(async () => { await request((t) => api.createCategory(t, newName.trim())); setNewName(""); })} />
      </Card>
      {cats.map((c, i) => (
        <Card key={c.id}>
          {editing === c.id ? (
            <>
              <Field label="Name" value={editName} onChangeText={setEditName} />
              <PrimaryButton label="Save name" disabled={!editName.trim() || offline}
                onPress={() => run(async () => { await request((t) => api.updateCategory(t, c.id, { name: editName.trim() })); setEditing(null); })} />
              <PrimaryButton variant="ghost" label="Cancel" onPress={() => setEditing(null)} />
            </>
          ) : (
            <>
              <View style={row.between}>
                <Text style={[text.title, { flex: 1 }]}>{c.name}</Text>
                {!c.isActive ? <Pill text="Inactive" tone="red" /> : null}
              </View>
              <Text style={text.sub}>{c.productCount} products</Text>
              <View style={[row.between, { marginTop: 8 }]}>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <Sq label="↑" onPress={() => move(i, -1)} disabled={i === 0 || offline} />
                  <Sq label="↓" onPress={() => move(i, 1)} disabled={i === cats.length - 1 || offline} />
                </View>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <Sq label="Rename" wide onPress={() => { setEditing(c.id); setEditName(c.name); }} />
                  <Sq label={c.isActive ? "Deactivate" : "Activate"} wide disabled={offline}
                    onPress={() => run(async () => { await request((t) => api.updateCategory(t, c.id, { isActive: !c.isActive })); })} />
                </View>
              </View>
            </>
          )}
        </Card>
      ))}
    </Page>
  );
}

function Sq({ label, onPress, disabled, wide }: { label: string; onPress: () => void; disabled?: boolean; wide?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" style={[s.sq, wide && { paddingHorizontal: 12 }, disabled && { opacity: 0.4 }]}>
      <Text style={s.sqText}>{label}</Text>
    </Pressable>
  );
}
const s = StyleSheet.create({
  sq: { minWidth: MIN_TOUCH, minHeight: MIN_TOUCH, borderRadius: radius.button, borderWidth: 1, borderColor: colors.ink, backgroundColor: colors.surface, alignItems: "center", justifyContent: "center" },
  sqText: { fontWeight: "600", color: colors.ink, fontSize: 14 },
});
