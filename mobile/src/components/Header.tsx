import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MIN_TOUCH, colors } from "../theme";
import { row, text } from "./ui";

export function Header({
  eyebrow,
  title,
  right,
  onBack,
  action,
}: {
  eyebrow: string;
  title: string;
  right?: React.ReactNode;
  onBack?: () => void;
  action?: { label: string; onPress: () => void };
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[s.h, { paddingTop: insets.top + 8 }]}>
      <View style={[row.between, { minHeight: MIN_TOUCH - 8 }]}>
        {onBack ? (
          <Pressable onPress={onBack} accessibilityRole="button" hitSlop={12} style={s.touch}>
            <Text style={s.link}>‹ Back</Text>
          </Pressable>
        ) : (
          <Text style={text.mono}>{eyebrow}</Text>
        )}
        {action ? (
          <Pressable onPress={action.onPress} accessibilityRole="button" hitSlop={12} style={s.touch}>
            <Text style={s.link}>{action.label}</Text>
          </Pressable>
        ) : null}
      </View>
      <View style={[row.between, { marginTop: 4 }]}>
        <Text style={s.title}>{title}</Text>
        {right}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  h: { paddingHorizontal: 20, paddingBottom: 14, backgroundColor: colors.ink },
  title: { fontSize: 22, fontWeight: "700", color: colors.paper, flexShrink: 1 },
  touch: { minHeight: 44, justifyContent: "center" },
  link: { color: colors.amber, fontWeight: "600", fontSize: 14 },
});
