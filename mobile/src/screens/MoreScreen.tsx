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
  const { user, signOut, lockNow, autoLockSeconds } = useAuth();
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
            {user?.role} · {user?.username}
          </Text>
        </Card>
        <Card>
          <Text style={text.title}>This device</Text>
          <Text style={text.sub}>{Device.deviceName ?? Device.modelName ?? "Android device"}</Text>
          <Text style={text.sub}>
            App {APP_VERSION} ({Constants.expoConfig?.android?.versionCode ?? 1}) · auto-lock {Math.round(autoLockSeconds / 60)} min · API {apiMode}
          </Text>
        </Card>

        {apiMode === "mock" ? (
          <Card>
            <Text style={text.title}>Mock controls</Text>
            <Toggle label="Offline" value={mockControls.offline} onChange={toggle("offline")} />
            <Toggle label="Expire access token (next call)" value={mockControls.expireAccessToken} onChange={toggle("expireAccessToken")} />
            <Toggle label="Revoke this device" value={mockControls.revokeDevice} onChange={toggle("revokeDevice")} />
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
