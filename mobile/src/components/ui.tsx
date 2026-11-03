import React from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { MIN_TOUCH, colors, radius } from "../theme";

export function Card({
  children,
  onPress,
  style,
}: {
  children: React.ReactNode;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const body = [s.card, style];
  if (!onPress) return <View style={body}>{children}</View>;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [body, pressed && { opacity: 0.7 }]}
    >
      {children}
    </Pressable>
  );
}

export function Pill({ text, tone = "amber" }: { text: string; tone?: "amber" | "red" }) {
  return (
    <View style={[s.pill, tone === "red" && { backgroundColor: colors.redSoft }]}>
      <Text style={[s.pillText, tone === "red" && { color: colors.redText }]}>{text}</Text>
    </View>
  );
}

export function PrimaryButton({
  label,
  onPress,
  loading,
  disabled,
  variant = "primary",
}: {
  label: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  variant?: "primary" | "ghost";
}) {
  const ghost = variant === "ghost";
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      accessibilityRole="button"
      style={({ pressed }) => [
        s.btn,
        ghost ? s.btnGhost : s.btnPrimary,
        (disabled || loading) && { opacity: 0.5 },
        pressed && { opacity: 0.8 },
      ]}
    >
      {loading ? (
        <ActivityIndicator color={colors.ink} />
      ) : (
        <Text style={s.btnText}>{label}</Text>
      )}
    </Pressable>
  );
}

export function Banner({ text }: { text: string }) {
  return (
    <View style={s.banner}>
      <Text style={s.bannerText}>{text}</Text>
    </View>
  );
}

export const text = StyleSheet.create({
  title: { fontWeight: "600", fontSize: 15, color: colors.text },
  sub: { fontSize: 13, color: colors.muted, marginTop: 4 },
  mono: {
    fontFamily: "monospace",
    fontWeight: "600",
    fontSize: 11,
    letterSpacing: 0.9,
    textTransform: "uppercase",
    color: colors.mono,
  },
});

export const row = StyleSheet.create({
  between: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
});

const s = StyleSheet.create({
  card: {
    marginHorizontal: 16,
    marginTop: 10,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.card,
    backgroundColor: colors.surface,
  },
  pill: {
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: radius.pill,
    backgroundColor: colors.amberSoft,
  },
  pillText: { fontSize: 12, fontWeight: "600", color: colors.ink },
  btn: {
    minHeight: MIN_TOUCH,
    borderRadius: radius.button,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 10,
  },
  btnPrimary: { backgroundColor: colors.amber },
  btnGhost: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.ink },
  btnText: { fontSize: 15, fontWeight: "600", color: colors.ink },
  banner: { backgroundColor: colors.amberSoft, paddingVertical: 8, paddingHorizontal: 16 },
  bannerText: { fontSize: 13, color: colors.ink, fontWeight: "500" },
});

export function Empty({ title, note }: { title: string; note?: string }) {
  return (
    <Card>
      <Text style={text.title}>{title}</Text>
      {note ? <Text style={text.sub}>{note}</Text> : null}
    </Card>
  );
}

export function Chip({
  label,
  active,
  onPress,
}: {
  label: string;
  active?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: !!active }}
      style={[cs.chip, active && cs.chipActive]}
    >
      <Text style={[cs.chipText, active && { fontWeight: "700" }]}>{label}</Text>
    </Pressable>
  );
}

const cs = StyleSheet.create({
  chip: {
    minHeight: 44,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    justifyContent: "center",
    marginRight: 8,
  },
  chipActive: { backgroundColor: colors.amberSoft, borderColor: colors.amber },
  chipText: { fontSize: 14, color: colors.ink },
});
