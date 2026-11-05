import { useNavigation, useRoute } from "@react-navigation/native";
import React, { useCallback, useEffect, useState } from "react";
import { Text } from "react-native";
import { api } from "../../api";
import type { PriceHistoryItem } from "../../api/typesV11";
import { useAuth } from "../../auth/AuthContext";
import { Card, Empty, PrimaryButton, text } from "../../components/ui";
import { formatKes, timeAgo } from "../../lib/format";
import { Page, errText } from "./common";

const SOURCE: Record<string, string> = { edit: "Edited", bulk: "Bulk change", bulk_revert: "Bulk revert", online_sync: "Online sync", web: "Website" };

export default function PriceHistoryScreen() {
  const nav = useNavigation<any>();
  const { id, name } = useRoute<any>().params as { id: number; name: string };
  const { request } = useAuth();
  const [items, setItems] = useState<PriceHistoryItem[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const load = useCallback(async (cursor?: string) => {
    try {
      const p = await request((t) => api.priceHistory(t, id, cursor));
      setItems((prev) => (cursor ? [...prev, ...p.items] : p.items));
      setNext(p.nextCursor);
      setError(null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setDone(true);
    }
  }, [request, id]);
  useEffect(() => { load(); }, [load]);

  return (
    <Page eyebrow="Price history" title={name} onBack={() => nav.goBack()} error={error} onRefresh={() => load()}>
      {done && items.length === 0 ? <Empty title="No price changes yet" /> : null}
      {items.map((h) => (
        <Card key={h.id}>
          <Text style={text.title}>{formatKes(h.oldPriceCents)} → {formatKes(h.newPriceCents)}</Text>
          <Text style={text.sub}>{SOURCE[h.source] ?? h.source} · {h.changedBy.name} · {timeAgo(h.changedAt)}</Text>
          {h.reason ? <Text style={text.sub}>“{h.reason}”</Text> : null}
        </Card>
      ))}
      {next ? <PrimaryButton variant="ghost" label="Load more" onPress={() => load(next)} /> : null}
    </Page>
  );
}
