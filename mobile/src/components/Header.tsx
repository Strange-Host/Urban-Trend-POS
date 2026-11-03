import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors } from "../theme";
import { row, text } from "./ui";

export function Header({
  eyebrow,
  title,
  right,
}: {
  eyebrow: string;
  title: string;
  right?: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[s.h, { paddingTop: insets.top + 14 }]}>
      <Text style={text.mono}>{eyebrow}</Text>
      <View style={[row.between, { marginTop: 12 }]}>
        <Text style={s.title}>{title}</Text>
        {right}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  h: { paddingHorizontal: 20, paddingBottom: 14, backgroundColor: colors.ink },
  title: { fontSize: 22, fontWeight: "700", color: colors.paper, flexShrink: 1 },
});
