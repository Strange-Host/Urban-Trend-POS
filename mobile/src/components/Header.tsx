import React, { useContext } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MIN_TOUCH, colors } from "../theme";
import { ShellContext } from "./Shell";
import { row, text } from "./ui";

/**
 * Page heading. Inside the shell (the main screens) the dark top bar already carries the status area and the menu,
 * so this is just the website's page title block on the paper background. Pushed detail screens sit outside the
 * shell and keep the dark bar with a Back link.
 */
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
  const inShell = useContext(ShellContext) && !onBack;

  if (inShell) {
    return (
      <View style={s.page}>
        <View style={[row.between, { alignItems: "flex-start" }]}>
          <View style={s.eyebrowPill}>
            <Text style={s.eyebrow}>{eyebrow}</Text>
          </View>
          {action ? (
            <Pressable onPress={action.onPress} accessibilityRole="button" hitSlop={8} style={s.actionBtn}>
              <Text style={s.actionText}>{action.label}</Text>
            </Pressable>
          ) : null}
        </View>
        <View style={[row.between, { marginTop: 10 }]}>
          <Text style={s.pageTitle}>{title}</Text>
          {right}
        </View>
      </View>
    );
  }

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

  // inside the shell: matches the website's "date pill + big title" block
  page: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 4, backgroundColor: colors.paper },
  eyebrowPill: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 99,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  eyebrow: { fontFamily: "monospace", fontSize: 11, color: colors.muted },
  pageTitle: { fontSize: 26, fontWeight: "700", color: colors.ink, letterSpacing: -0.4, flexShrink: 1 },
  actionBtn: {
    minHeight: 36,
    paddingHorizontal: 14,
    borderRadius: 99,
    backgroundColor: colors.amber,
    alignItems: "center",
    justifyContent: "center",
  },
  actionText: { fontWeight: "700", fontSize: 13, color: colors.ink },
});
