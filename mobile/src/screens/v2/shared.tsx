import React, { useEffect, useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { telUrl, whatsappUrl } from "../../lib/phone";
import { Pill } from "../../components/ui";
import { countdown } from "../../lib/telesales";
import { MIN_TOUCH, colors, radius } from "../../theme";

/** Ticks once a minute (and on mount) so a countdown label stays fresh while the screen is open. */
export function useMinuteTick(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const h = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(h);
  }, []);
  return now;
}

/** "42 min left", red when under 30 minutes or ended. */
export function CountdownPill({ confirmBy, serverTime, fetchedAt, now }: { confirmBy: string | null; serverTime: string | null; fetchedAt: number; now: number }) {
  const c = countdown(confirmBy, serverTime, fetchedAt, now);
  if (!c) return null;
  return <Pill text={c.label} tone={c.urgent ? "red" : "amber"} />;
}

/** Call and WhatsApp buttons for a phone number. Opens the phone's own apps; nothing is sent from here. */
export function ContactButtons({ phone }: { phone: string | null }) {
  if (!phone) return null;
  const wa = whatsappUrl(phone);
  return (
    <View style={s.row}>
      <Pressable style={s.btn} accessibilityRole="button" accessibilityLabel={`Call ${phone}`} onPress={() => Linking.openURL(telUrl(phone)).catch(() => {})}>
        <Text style={s.btnText}>Call</Text>
      </Pressable>
      {wa ? (
        <Pressable style={s.btn} accessibilityRole="button" accessibilityLabel="Open WhatsApp" onPress={() => Linking.openURL(wa).catch(() => {})}>
          <Text style={s.btnText}>WhatsApp</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: "row", gap: 10, marginTop: 10 },
  btn: { flex: 1, minHeight: MIN_TOUCH, borderRadius: radius.button, borderWidth: 1, borderColor: colors.ink, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface },
  btnText: { fontWeight: "700", color: colors.ink },
});
