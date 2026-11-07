import { useFocusEffect, useNavigation, useRoute } from "@react-navigation/native";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { api } from "../api";
import { isApiError } from "../api/errors";
import type { StockItem } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { Header } from "../components/Header";
import { Banner, Card, Empty, PrimaryButton, row, text } from "../components/ui";
import { cache } from "../lib/storage";
import { MIN_TOUCH, colors, radius } from "../theme";

type Query = { barcode: string } | { q: string };
const keyOf = (q: Query) => ("barcode" in q ? `stock:b:${q.barcode}` : `stock:q:${q.q.trim().toLowerCase()}`);

export default function StockScreen() {
  const nav = useNavigation<any>();
  const route = useRoute<any>();
  const { user, request } = useAuth();
  const [text_, setText] = useState("");
  const [query, setQuery] = useState<Query | null>(null);
  const [items, setItems] = useState<StockItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<React.ComponentRef<typeof TextInput>>(null);
  const seq = useRef(0);
  const canAdjust = !!user?.permissions.includes("inventory.adjust");

  const run = useCallback(
    async (q: Query) => {
      const my = ++seq.current;
      setLoading(true);
      setError(null);
      setNote(null);
      try {
        const res = await request((t) => api.stockLookup(t, "barcode" in q ? { barcode: q.barcode } : { q: q.q }));
        if (my !== seq.current) return;
        setItems(res);
        if (user) cache.set(user.id, keyOf(q), res).catch(() => {});
      } catch (e) {
        if (my !== seq.current) return;
        if (isApiError(e) && e.code === "NETWORK" && user) {
          const c = await cache.get<StockItem[]>(user.id, keyOf(q));
          if (my !== seq.current) return;
          if (c) {
            setItems(c.data);
            setNote("Offline · showing the last saved result. Adjusting needs a connection.");
          } else {
            setItems(null);
            setError("No connection and nothing saved for this search.");
          }
        } else {
          setError(isApiError(e) ? e.message : "Lookup failed");
        }
      } finally {
        if (my === seq.current) setLoading(false);
      }
    },
    [request, user],
  );

  // a scan hands its barcode over through route params
  const barcode: string | undefined = route.params?.barcode;
  const nonce: number | undefined = route.params?.nonce;
  useEffect(() => {
    if (!barcode) return;
    setText("");
    const q = { barcode };
    setQuery(q);
    run(q);
  }, [barcode, nonce, run]);

  // typing searches by name or SKU after a short pause
  useEffect(() => {
    const t = text_.trim();
    if (t.length < 2) return;
    const id = setTimeout(() => {
      const q = { q: t };
      setQuery(q);
      run(q);
    }, 350);
    return () => clearTimeout(id);
  }, [text_, run]);

  // coming back from Adjust: refresh the numbers
  const first = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (first.current) {
        first.current = false;
        return;
      }
      if (query) run(query);
    }, [query, run]),
  );

  const unknownBarcode = query && "barcode" in query && items && items.length === 0;

  return (
    <View style={{ flex: 1, backgroundColor: colors.paper }}>
      <Header eyebrow="Urban Trends" title="Stock" action={{ label: "Scan", onPress: () => nav.navigate("Scan") }} />
      {note ? <Banner text={note} /> : null}
      <View style={s.searchRow}>
        <TextInput
          ref={input}
          style={s.input}
          value={text_}
          onChangeText={setText}
          placeholder="Search name or SKU"
          placeholderTextColor={colors.muted}
          autoCorrect={false}
          returnKeyType="search"
          onSubmitEditing={Keyboard.dismiss}
        />
        <Pressable style={s.scanBtn} accessibilityRole="button" onPress={() => nav.navigate("Scan")}>
          <Text style={s.scanText}>Scan</Text>
        </Pressable>
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 24 }}>
        {loading ? <ActivityIndicator style={{ marginTop: 24 }} color={colors.ink} /> : null}
        {error ? <Empty title="Could not look up stock" note={error} /> : null}
        {!loading && !query && !error ? (
          <Empty title="Scan a barcode or search" note="Shows stock by state: available, awaiting dispatch, dispatched unpaid and paid, returned." />
        ) : null}
        {!loading && unknownBarcode ? (
          <Card>
            <Text style={text.title}>No product with this barcode</Text>
            <Text style={text.sub}>{(query as { barcode: string }).barcode}</Text>
            <PrimaryButton
              label="Search by name"
              onPress={() => {
                setQuery(null);
                setItems(null);
                input.current?.focus();
              }}
            />
          </Card>
        ) : null}
        {!loading && query && "q" in query && items && items.length === 0 ? <Empty title="No matches" note="Try part of the name or the SKU." /> : null}
        {!loading &&
          items?.map((p) => (
            <Card key={p.id}>
              <View style={row.between}>
                <Text style={[text.title, { flexShrink: 1 }]}>{p.name}</Text>
                <Text style={s.avail}>{p.available}</Text>
              </View>
              <Text style={text.sub}>
                {p.sku}
                {p.barcode ? ` · ${p.barcode}` : ""} · available
              </Text>
              <View style={s.grid}>
                <State label="Awaiting dispatch" value={p.awaitingDispatch} />
                <State label="Dispatched unpaid" value={p.dispatchedUnpaid} />
                <State label="Dispatched paid" value={p.dispatchedPaid} />
                <State label="Returned" value={p.returned} />
              </View>
              {canAdjust ? <PrimaryButton label="Adjust stock" variant="ghost" onPress={() => nav.navigate("Adjust", { item: p })} /> : null}
            </Card>
          ))}
      </ScrollView>
    </View>
  );
}

function State({ label, value }: { label: string; value: number }) {
  return (
    <View style={s.state}>
      <Text style={s.stateVal}>{value}</Text>
      <Text style={s.stateLabel}>{label}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  searchRow: { flexDirection: "row", gap: 8, marginHorizontal: 16, marginTop: 12 },
  input: {
    flex: 1,
    minHeight: MIN_TOUCH,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.button,
    backgroundColor: colors.surface,
    paddingHorizontal: 12,
    fontSize: 16,
    color: colors.text,
  },
  scanBtn: { minHeight: MIN_TOUCH, paddingHorizontal: 18, borderRadius: radius.button, backgroundColor: colors.amber, justifyContent: "center" },
  scanText: { fontWeight: "700", fontSize: 15, color: colors.ink },
  avail: { fontSize: 24, fontWeight: "700", color: colors.text },
  grid: { flexDirection: "row", flexWrap: "wrap", marginTop: 10 },
  state: { width: "50%", paddingVertical: 6 },
  stateVal: { fontSize: 16, fontWeight: "600", color: colors.text },
  stateLabel: { fontSize: 12, color: colors.muted },
});
