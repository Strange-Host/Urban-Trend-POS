import { useNavigation, useRoute } from "@react-navigation/native";
import React, { useEffect, useState } from "react";
import { Alert, ScrollView, Switch, Text, View } from "react-native";
import { api } from "../../api";
import type { Category, Product } from "../../api/typesV11";
import { useAuth } from "../../auth/AuthContext";
import { Card, Chip, PrimaryButton, row, text } from "../../components/ui";
import { formatKes } from "../../lib/format";
import { centsToInput, parseKesToCents } from "../../lib/money";
import { can } from "../../lib/permissions";
import { useSecureScreen } from "../../lib/secureScreen";
import { Field, Page, errText } from "./common";

export default function ProductEditScreen() {
  const nav = useNavigation<any>();
  const id = (useRoute<any>().params?.id as number | undefined) ?? null;
  const { request, user, offline } = useAuth();
  useSecureScreen("product");
  const [orig, setOrig] = useState<Product | null>(null);
  const [cats, setCats] = useState<Category[]>([]);
  const [master, setMaster] = useState<"pos" | "online">("pos");
  const [name, setName] = useState("");
  const [sku, setSku] = useState("");
  const [barcode, setBarcode] = useState("");
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [price, setPrice] = useState("");
  const [cost, setCost] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const costKnown = can(user, "products.view_cost");

  useEffect(() => {
    request((t) => api.categories(t)).then(setCats).catch(() => {});
    request((t) => api.catalogSettings(t)).then((c) => setMaster(c.priceMaster)).catch(() => {});
    if (id === null) return;
    request((t) => api.product(t, id)).then((p) => {
      setOrig(p); setName(p.name); setSku(p.sku); setBarcode(p.barcode ?? ""); setCategoryId(p.categoryId);
      setPrice(centsToInput(p.sellPriceCents)); setIsActive(p.isActive);
      if (p.costPriceCents !== undefined) setCost(centsToInput(p.costPriceCents));
    }).catch((e) => setError(errText(e)));
  }, [id, request]);

  const priceCents = parseKesToCents(price);
  const costCents = cost.trim() ? parseKesToCents(cost) : null;
  const priceChanged = !!orig && priceCents !== null && priceCents !== orig.sellPriceCents;
  const invalid = !name.trim() || !sku.trim() || priceCents === null || priceCents <= 0 || (costCents === null && cost.trim() !== "") || (priceChanged && !reason.trim());

  async function save() {
    if (invalid || priceCents === null) return;
    setBusy(true);
    setError(null);
    try {
      const body = {
        name: name.trim(), sku: sku.trim(), barcode: barcode.trim() || null, categoryId, sellPriceCents: priceCents, isActive,
        ...(costKnown && costCents !== null ? { costPriceCents: costCents } : {}),
      };
      if (id === null) await request((t) => api.createProduct(t, body));
      else await request((t) => api.updateProduct(t, id, { ...body, ...(priceChanged ? { reason: reason.trim() } : {}) }));
      nav.goBack();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  function confirmDeactivate() {
    Alert.alert("Deactivate product?", "It stops showing in the shop. History is kept and you can switch it back on.", [
      { text: "Cancel", style: "cancel" },
      { text: "Deactivate", style: "destructive", onPress: () => setIsActive(false) },
    ]);
  }

  return (
    <Page eyebrow="Catalog" title={id === null ? "New product" : "Edit product"} onBack={() => nav.goBack()} error={error}>
      <Card>
        <Field label="Name" value={name} onChangeText={setName} />
        <Field label="SKU" value={sku} onChangeText={setSku} autoCapitalize="characters" />
        <Field label="Barcode (optional)" value={barcode} onChangeText={setBarcode} keyboardType="number-pad" />
      </Card>
      <Card>
        <Text style={text.title}>Category</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 8 }}>
          <Chip label="None" active={categoryId === null} onPress={() => setCategoryId(null)} />
          {cats.filter((c) => c.isActive || c.id === categoryId).map((c) => <Chip key={c.id} label={c.name} active={categoryId === c.id} onPress={() => setCategoryId(c.id)} />)}
        </ScrollView>
      </Card>
      <Card>
        <Field label="Selling price (KES)" value={price} onChangeText={setPrice} keyboardType="decimal-pad" />
        {master === "online" ? <Text style={text.sub}>Online prices are managed in the online store; changes here apply to the shop catalogue.</Text> : null}
        {priceChanged && orig ? (
          <>
            <Text style={[text.sub, { marginTop: 8 }]}>{formatKes(orig.sellPriceCents)} → {priceCents !== null ? formatKes(priceCents) : "?"}</Text>
            <Field label="Reason for the price change (required)" value={reason} onChangeText={setReason} />
          </>
        ) : null}
        {costKnown && (id === null || orig?.costPriceCents !== undefined) ? <Field label="Cost price (KES)" value={cost} onChangeText={setCost} keyboardType="decimal-pad" /> : null}
      </Card>
      {id !== null ? (
        <Card>
          <View style={row.between}>
            <Text style={text.title}>{isActive ? "Active" : "Inactive"}</Text>
            <Switch value={isActive} onValueChange={(v) => (v ? setIsActive(true) : confirmDeactivate())} />
          </View>
          <Text style={text.sub}>Products are never deleted, only deactivated.</Text>
        </Card>
      ) : null}
      <View style={{ marginHorizontal: 16 }}>
        <PrimaryButton label={id === null ? "Create product" : "Save changes"} onPress={save} loading={busy} disabled={invalid || offline} />
        {id !== null ? <PrimaryButton variant="ghost" label="Price history" onPress={() => nav.navigate("PriceHistory", { id, name: orig?.name ?? name })} /> : null}
      </View>
    </Page>
  );
}
