import React from "react";
import { Linking, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { APP_VERSION, useAuth } from "../auth/AuthContext";
import { PrimaryButton, text } from "../components/ui";
import { colors } from "../theme";

// Blocking screen shown when the installed version is below GET /app/version minimum.
export default function UpdateScreen() {
  const { update } = useAuth();
  const insets = useSafeAreaInsets();
  return (
    <View style={[s.root, { paddingTop: insets.top + 80, paddingBottom: insets.bottom + 24 }]}>
      <Text style={text.mono}>Urban Trends</Text>
      <Text style={s.h1}>Update required</Text>
      <Text style={s.sub}>
        This version ({APP_VERSION}) is no longer supported. Install {update?.latestVersion ?? "the latest version"} to
        continue.
      </Text>
      <View style={{ flex: 1 }} />
      {update?.downloadUrl ? (
        <PrimaryButton label="Download update" onPress={() => Linking.openURL(update.downloadUrl as string)} />
      ) : (
        <Text style={s.sub}>There is no download link yet. Ask the owner for the new version.</Text>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.ink, paddingHorizontal: 24 },
  h1: { fontSize: 30, fontWeight: "700", color: colors.paper, marginTop: 12 },
  sub: { fontSize: 15, color: colors.mono, marginTop: 10, lineHeight: 21 },
});
