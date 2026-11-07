import Constants from "expo-constants";
import * as Device from "expo-device";
import React, { useState } from "react";
import { ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { apiMode } from "../api";
import { mockControls } from "../api/mock/mockApi";
import { APP_VERSION, useAuth } from "../auth/AuthContext";
import { Header } from "../components/Header";
import { Card, PrimaryButton, row, text } from "../components/ui";
import { colors } from "../theme";

export default function MoreScreen() {
  const { user, signOut, lockNow, autoLockSeconds, approvalBiometricAboveCents } = useAuth();
  const [busy, setBusy] = useState(false);
  const [, force] = useState(0);

  const toggle = (key: "offline" | "revokeDevice" | "expireAccessToken" | "forceUpdate") => (v: boolean) => {
    mockControls[key] = v;
    force((n) => n + 1);
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.paper }}>
      <Header eyebrow="Urban Trends" title="More" />
      <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
        <Card>
          <Text style={text.title}>{user?.name}</Text>
          <Text style={text.sub}>
            {user?.role} · {user?.email}
          </Text>
        </Card>
        <Card>
          <Text style={text.title}>This device</Text>
          <Text style={text.sub}>{Device.deviceName ?? Device.modelName ?? "Android device"}</Text>
          <Text style={text.sub}>
            App {APP_VERSION} ({Constants.expoConfig?.android?.versionCode ?? 1}) · auto-lock {Math.round(autoLockSeconds / 60)} min · API {apiMode}
          </Text>
        </Card>

        <Card>
          <Text style={text.title}>Security</Text>
          <Text style={text.sub}>Unlocks with fingerprint, face or screen lock. Locks after {Math.round(autoLockSeconds / 60)} min in the background.</Text>
          <Text style={text.sub}>
            {approvalBiometricAboveCents === null
              ? "Approvals do not ask for biometric confirmation."
              : `Approvals of KES ${Math.round(approvalBiometricAboveCents / 100).toLocaleString("en-US")} or more ask for biometric confirmation.`}
          </Text>
          <Text style={text.sub}>Approvals, cost and payment screens block screenshots. The owner can revoke this device from the web app.</Text>
        </Card>

        {apiMode === "mock" ? (
          <Card>
            <Text style={text.title}>Mock controls</Text>
            <Toggle label="Offline" value={mockControls.offline} onChange={toggle("offline")} />
            <Toggle label="Expire access token (next call)" value={mockControls.expireAccessToken} onChange={toggle("expireAccessToken")} />
            <Toggle label="Revoke this device" value={mockControls.revokeDevice} onChange={toggle("revokeDevice")} />
            <Toggle label="Next approval already decided by someone else" value={mockControls.alreadyDecided} onChange={(v) => { mockControls.alreadyDecided = v; force((n) => n + 1); }} />
            <Toggle label="Force update (applies on next launch)" value={mockControls.forceUpdate} onChange={toggle("forceUpdate")} />
          </Card>
        ) : null}

        <PrimaryButton label="Lock now" variant="ghost" onPress={lockNow} />
        <PrimaryButton
          label="Sign out"
          loading={busy}
          onPress={async () => {
            setBusy(true);
            await signOut();
          }}
        />
      </ScrollView>
    </View>
  );
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={[row.between, s.toggle]}>
      <Text style={[text.sub, { marginTop: 0, flexShrink: 1 }]}>{label}</Text>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: colors.amber }} />
    </View>
  );
}

const s = StyleSheet.create({
  toggle: { paddingVertical: 6, minHeight: 44, borderBottomWidth: 1, borderBottomColor: colors.lineSoft },
});
