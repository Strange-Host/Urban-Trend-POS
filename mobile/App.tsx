import { NavigationContainer } from "@react-navigation/native";
import { StatusBar } from "expo-status-bar";
import React from "react";
import { ActivityIndicator, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AuthProvider, useAuth } from "./src/auth/AuthContext";
import RootTabs from "./src/navigation/RootTabs";
import LockScreen from "./src/screens/LockScreen";
import LoginScreen from "./src/screens/LoginScreen";
import UpdateScreen from "./src/screens/UpdateScreen";
import { colors } from "./src/theme";

function Gate() {
  const { status } = useAuth();
  switch (status) {
    case "booting":
      return (
        <View style={{ flex: 1, backgroundColor: colors.ink, justifyContent: "center" }}>
          <ActivityIndicator color={colors.amber} />
        </View>
      );
    case "updateRequired":
      return <UpdateScreen />;
    case "signedOut":
      return <LoginScreen />;
    case "locked":
      return <LockScreen />;
    case "unlocked":
      return (
        <NavigationContainer>
          <RootTabs />
        </NavigationContainer>
      );
  }
}

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
