import { useFocusEffect, useNavigation } from "@react-navigation/native";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { api } from "../../api";
import type { Category, Product } from "../../api/typesV11";
import { useAuth } from "../../auth/AuthContext";
import { Card, Chip, Empty, Pill, PrimaryButton, row, text } from "../../components/ui";
import { formatKes } from "../../lib/format";
import { can } from "../../lib/permissions";
import { useSecureScreen } from "../../lib/secureScreen";
import { MIN_TOUCH, colors, radius } from "../../theme";
import { Page, errText } from "./common";

export default function CatalogScreen() {
  const nav = useNavigation<any>();
  const { request, user } = useAuth();
  useSecureScreen("catalog");
  const [q, setQ] = useState("");
  const [categoryId, setCategoryId] = useState<number | undefined>();
  const [active, setActive] = useState(true);
  const [cats, setCats] = useState<Category[]>([]);
  const [items, setItems] = useState<Product[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async (cursor?: string) => {
    const mine = ++seq.current; // a slow earlier search must not overwrite a newer one
    setLoading(true);
    try {
      const page = await request((t) => api.products(t, { q: q.trim() || undefined, categoryId, active, cursor }));
      if (mine !== seq.current) return;
      setItems((prev) => (cursor ? [...prev, ...page.items] : page.items));
      setNext(page.nextCursor);
      setError(null);
    } catch (e) {
      if (mine === seq.current) setError(errText(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [request, q, categoryId, active]);

  useEffect(() => {
    const h = setTimeout(() => load(), 250);
    return () => clearTimeout(h);
  }, [load]);
  useFocusEffect(useCallback(() => {
    request((t) => api.categories(t)).then(setCats).catch(() => {});
    load();
  }, [request, load]));

  const showCost = can(user, "products.view_cost");
  return (
    <Page eyebrow="Stock" title="Catalog" onBack={() => nav.goBack()} error={error} onRefresh={() => load()} refreshing={loading && items.length > 0}
      action={{ label: "+ New", onPress: () => nav.navigate("ProductEdit", {}) }}>
      <View style={s.tools}>
        <TextInput style={s.search} value={q} onChangeText={setQ} placeholder="Search name, SKU or barcode" placeholderTextColor={colors.muted} autoCapitalize="none" />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 10 }}>
        <Chip label="All" active={categoryId === undefined} onPress={() => setCategoryId(undefined)} />
        {cats.filter((c) => c.isActive).map((c) => <Chip key={c.id} label={c.name} active={categoryId === c.id} onPress={() => setCategoryId(c.id)} />)}
      </ScrollView>
      <View style={[row.between, { paddingHorizontal: 16, paddingTop: 6 }]}>
        <Chip label={active ? "Active only" : "Showing inactive"} active={!active} onPress={() => setActive(!active)} />
        <View style={{ flexDirection: "row" }}>
          <Pressable onPress={() => nav.navigate("Categories")} style={s.link} accessibilityRole="button"><Text style={s.linkText}>Categories</Text></Pressable>
          {can(user, "prices.bulk") ? <Pressable onPress={() => nav.navigate("BulkPrice")} style={s.link} accessibilityRole="button"><Text style={s.linkText}>Bulk price</Text></Pressable> : null}
        </View>
      </View>
      {items.length === 0 && !loading ? <Empty title="No products" note="Try another search or filter." /> : null}
      {items.map((p) => (
        <Card key={p.id} onPress={() => nav.navigate("ProductEdit", { id: p.id })}>
          <View style={row.between}>
            <Text style={[text.title, { flex: 1 }]} numberOfLines={2}>{p.name}</Text>
            {!p.isActive ? <Pill text="Inactive" tone="red" /> : null}
          </View>
          <Text style={text.sub}>{p.sku}{p.categoryName ? ` · ${p.categoryName}` : ""}</Text>
          <View style={[row.between, { marginTop: 6 }]}>
            <Text style={text.title}>{formatKes(p.sellPriceCents)}</Text>
            {showCost && p.costPriceCents !== undefined ? <Text style={text.sub}>Cost {formatKes(p.costPriceCents)}</Text> : null}
          </View>
        </Card>
      ))}
      {next ? <View style={{ marginHorizontal: 16 }}><PrimaryButton variant="ghost" label="Load more" onPress={() => load(next)} loading={loading} /></View> : null}
    </Page>
  );
}

const s = StyleSheet.create({
  tools: { paddingHorizontal: 16, paddingTop: 10 },
  search: { minHeight: MIN_TOUCH, borderWidth: 1, borderColor: colors.line, borderRadius: radius.button, paddingHorizontal: 12, fontSize: 15, color: colors.text, backgroundColor: colors.surface },
  link: { minHeight: MIN_TOUCH, paddingHorizontal: 10, justifyContent: "center" },
  linkText: { fontWeight: "600", color: colors.ink, textDecorationLine: "underline" },
});
