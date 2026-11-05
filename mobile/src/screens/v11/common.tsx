import React from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps } from "react-native";
import { isApiError } from "../../api/errors";
import { useAuth } from "../../auth/AuthContext";
import { Header } from "../../components/Header";
import { Banner } from "../../components/ui";
import { MIN_TOUCH, colors, radius } from "../../theme";

/** One place that turns an API failure into a sentence for the person. Known v1.1 codes get plain wording. */
const WORDS: Record<string, string> = {
  NETWORK: "No connection. This needs internet.",
  DUPLICATE_SKU: "Another product already uses that SKU.",
  DUPLICATE_BARCODE: "Another product already uses that barcode.",
  DUPLICATE_NAME: "That name is already taken.",
  REASON_REQUIRED: "Add a reason for the price change.",
  INVALID_PRICE: "That price is not valid.",
  PREVIEW_STALE: "Prices changed since you previewed. Preview again before applying.",
  ALREADY_REVERTED: "That change was already reverted.",
  NOTHING_TO_REVERT: "Nothing left to revert: those products were repriced since.",
  NOT_DRAFT: "This stock-take is no longer a draft.",
  NOT_PENDING: "This stock-take was already decided.",
  SELF_APPROVAL: "Someone else has to approve a count you submitted.",
  ALREADY_MATCHED: "That payment was already matched. The list will refresh.",
  ALREADY_SETTLED: "One of those parcels is already settled. Reload and pick again.",
  STATEMENT_EXCEEDS_COLLECTIONS: "The amount is more than was collected.",
  CLOCKOUT_BLOCKED: "You cannot clock out yet. Finish what is listed below.",
  CLOCKOUT_REASON_REQUIRED: "Add a handover note explaining what is still open.",
  CLOCKOUT_CONFIRMATION_REQUIRED: "Confirm the checks below to clock out.",
  MODULE_DISABLED: "Attendance is not switched on for this shop.",
};
export function errText(e: unknown): string {
  if (!isApiError(e)) return "Something went wrong";
  return WORDS[e.code] ?? e.message;
}

/** Page frame for the v1.1 detail screens: dark Back header, offline and error banners, pull to refresh. */
export function Page({
  eyebrow, title, onBack, action, error, children, onRefresh, refreshing, footer,
}: {
  eyebrow: string; title: string; onBack: () => void; action?: { label: string; onPress: () => void };
  error?: string | null; children: React.ReactNode; onRefresh?: () => void; refreshing?: boolean; footer?: React.ReactNode;
}) {
  const { offline } = useAuth();
  return (
    <View style={{ flex: 1, backgroundColor: colors.paper }}>
      <Header eyebrow={eyebrow} title={title} onBack={onBack} action={action} />
      {offline ? <Banner text="Offline · changes need a connection." /> : null}
      {error ? <Banner text={error} /> : null}
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: 32 }}
        refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} /> : undefined}
      >
        {children}
      </ScrollView>
      {footer}
    </View>
  );
}

export function Field({ label, ...props }: { label: string } & TextInputProps) {
  return (
    <View style={{ marginTop: 10 }}>
      <Text style={f.label}>{label}</Text>
      <TextInput style={f.input} placeholderTextColor={colors.muted} {...props} />
    </View>
  );
}

const f = StyleSheet.create({
  label: { fontSize: 12, color: colors.muted, marginBottom: 4 },
  input: { minHeight: MIN_TOUCH, borderWidth: 1, borderColor: colors.line, borderRadius: radius.button, paddingHorizontal: 12, fontSize: 15, color: colors.text, backgroundColor: colors.surface },
});
