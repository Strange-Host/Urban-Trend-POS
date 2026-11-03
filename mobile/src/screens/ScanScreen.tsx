import { useNavigation } from "@react-navigation/native";
import { CameraView, useCameraPermissions } from "expo-camera";
import React, { useRef } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PrimaryButton } from "../components/ui";
import { colors } from "../theme";

export default function ScanScreen() {
  const nav = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const [perm, requestPerm] = useCameraPermissions();
  const done = useRef(false);

  if (!perm) return <View style={s.root} />;

  if (!perm.granted) {
    return (
      <View style={[s.root, s.center, { paddingTop: insets.top }]}>
        <Text style={s.msg}>Camera access is needed to scan barcodes.</Text>
        <View style={{ width: "100%", paddingHorizontal: 24 }}>
          <PrimaryButton label="Allow camera" onPress={requestPerm} />
          <PrimaryButton label="Cancel" variant="ghost" onPress={() => nav.goBack()} />
        </View>
      </View>
    );
  }

  return (
    <View style={s.root}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ["ean13", "ean8", "code128", "qr"] }}
        onBarcodeScanned={({ data }) => {
          if (done.current || !data) return;
          done.current = true; // one result per scan
          nav.navigate("Tabs", { screen: "Stock", params: { barcode: data, nonce: Date.now() } });
        }}
      />
      <View style={[s.frame, { top: insets.top + 120 }]} pointerEvents="none" />
      <View style={[s.bottom, { paddingBottom: insets.bottom + 16 }]}>
        <Text style={s.hint}>Point at the barcode</Text>
        <PrimaryButton label="Cancel" variant="ghost" onPress={() => nav.goBack()} />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.ink },
  center: { alignItems: "center", justifyContent: "center" },
  msg: { color: colors.paper, fontSize: 16, textAlign: "center", marginBottom: 16, paddingHorizontal: 24 },
  frame: { position: "absolute", alignSelf: "center", width: 280, height: 160, borderWidth: 3, borderColor: colors.amber, borderRadius: 12 },
  bottom: { position: "absolute", left: 24, right: 24, bottom: 0 },
  hint: { color: colors.paper, textAlign: "center", fontSize: 15, marginBottom: 4 },
});
