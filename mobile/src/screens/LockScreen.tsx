import React, { useCallback, useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "../auth/AuthContext";
import { biometricAvailable } from "../lib/biometric";
import { PrimaryButton, text } from "../components/ui";
import { colors } from "../theme";

export default function LockScreen() {
  const { user, unlock, signOut } = useAuth();
  const insets = useSafeAreaInsets();
  const [failed, setFailed] = useState(false);
  const [noBiometric, setNoBiometric] = useState(false);

  const attempt = useCallback(async () => {
    setFailed(false);
    if (!(await biometricAvailable())) {
      setNoBiometric(true);
      return;
    }
    const ok = await unlock();
    if (!ok) setFailed(true);
  }, [unlock]);

  useEffect(() => {
    attempt();
  }, [attempt]);

  return (
    <View style={[s.root, { paddingTop: insets.top + 80, paddingBottom: insets.bottom + 24 }]}>
      <Text style={text.mono}>Urban Trends</Text>
      <Text style={s.h1}>Locked</Text>
      <Text style={s.sub}>{user ? `Signed in as ${user.name}` : ""}</Text>
      <View style={{ flex: 1 }} />
      {noBiometric ? (
        <Text style={s.warn}>
          No fingerprint, face or screen lock is set up on this phone. Set one in Android settings, or
          sign in with your password.
        </Text>
      ) : failed ? (
        <Text style={s.warn}>Could not unlock. Try again.</Text>
      ) : null}
      <PrimaryButton label="Unlock" onPress={attempt} />
      <PrimaryButton label="Use password instead" variant="ghost" onPress={signOut} />
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.ink, paddingHorizontal: 24 },
  h1: { fontSize: 30, fontWeight: "700", color: colors.paper, marginTop: 12 },
  sub: { fontSize: 15, color: colors.mono, marginTop: 6 },
  warn: { color: colors.ink, backgroundColor: colors.amberSoft, padding: 10, borderRadius: 8, fontSize: 14, marginBottom: 6 },
});
