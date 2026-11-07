import React, { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { apiMode } from "../api";
import { isApiError } from "../api/errors";
import { useAuth } from "../auth/AuthContext";
import type { OtpChallenge } from "../api/types";
import { PrimaryButton, text } from "../components/ui";
import { MIN_TOUCH, colors, radius } from "../theme";

export default function LoginScreen() {
  const { signIn, verifyOtp, notice } = useAuth();
  const insets = useSafeAreaInsets();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [challenge, setChallenge] = useState<OtpChallenge | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fail = (e: unknown) => {
    setError(
      isApiError(e)
        ? e.code === "NETWORK"
          ? "No connection. Sign in needs internet."
          : e.message
        : "Something went wrong",
    );
    setBusy(false);
  };

  async function submit() {
    if (!email.trim() || !password) {
      setError("Enter your email and password");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const c = await signIn(email.trim(), password);
      if (c) {
        setChallenge(c);
        setBusy(false);
      }
    } catch (e) {
      fail(e);
    }
  }

  async function submitCode() {
    if (!challenge || !code.trim()) {
      setError("Enter the code we sent");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await verifyOtp(challenge, code.trim());
    } catch (e) {
      fail(e);
    }
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.ink }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ flexGrow: 1, paddingTop: insets.top + 56, paddingBottom: 24 }}
      >
        <View style={{ paddingHorizontal: 24 }}>
          <Text style={text.mono}>Urban Trends</Text>
          <Text style={s.h1}>Sign in</Text>
        </View>
        <View style={s.sheet}>
          {notice ? <Text style={s.notice}>{notice}</Text> : null}
          {challenge ? (
            <>
              <Text style={s.label}>Code sent to {challenge.phoneHint}</Text>
              <TextInput
                style={s.input}
                value={code}
                onChangeText={setCode}
                keyboardType="number-pad"
                autoComplete="one-time-code"
                textContentType="oneTimeCode"
                maxLength={12}
                returnKeyType="go"
                onSubmitEditing={submitCode}
                autoFocus
              />
            </>
          ) : (
            <>
              <Text style={s.label}>Email</Text>
              <TextInput
                style={s.input}
                value={email}
                onChangeText={setEmail}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                autoComplete="email"
                textContentType="emailAddress"
                returnKeyType="next"
              />
              <Text style={s.label}>Password</Text>
              <TextInput
                style={s.input}
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                autoCapitalize="none"
                autoComplete="password"
                textContentType="password"
                returnKeyType="go"
                onSubmitEditing={submit}
              />
            </>
          )}
          {error ? <Text style={s.error}>{error}</Text> : null}
          <PrimaryButton label={challenge ? "Confirm code" : "Sign in"} onPress={challenge ? submitCode : submit} loading={busy} />
          {challenge ? (
            <Text style={s.hint} onPress={() => { setChallenge(null); setCode(""); setError(null); }}>
              Use a different account
            </Text>
          ) : null}
          <Text style={s.hint}>
            You sign in with a password once on this phone. After that it unlocks with your
            fingerprint or face.
          </Text>
          {apiMode === "mock" ? (
            <Text style={s.mock}>Mock API · owner@urbantrends.test / owner123 · manager@urbantrends.test / manager123</Text>
          ) : null}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  h1: { fontSize: 30, fontWeight: "700", color: colors.paper, marginTop: 12, marginBottom: 28 },
  sheet: {
    flex: 1,
    backgroundColor: colors.paper,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 24,
    minHeight: 420,
  },
  label: { fontSize: 13, color: colors.muted, marginTop: 14, marginBottom: 6 },
  input: {
    minHeight: MIN_TOUCH,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.button,
    backgroundColor: colors.surface,
    paddingHorizontal: 12,
    fontSize: 16,
    color: colors.text,
  },
  error: { color: colors.redText, backgroundColor: colors.redSoft, padding: 10, borderRadius: 8, marginTop: 14, fontSize: 14 },
  notice: { color: colors.ink, backgroundColor: colors.amberSoft, padding: 10, borderRadius: 8, fontSize: 14 },
  hint: { fontSize: 13, color: colors.muted, marginTop: 18, lineHeight: 18 },
  mock: { fontSize: 12, color: colors.muted, marginTop: 18, fontFamily: "monospace" },
});
