import { createNativeStackNavigator } from "@react-navigation/native-stack";
import React from "react";
import AdjustScreen from "../screens/AdjustScreen";
import AlertsScreen from "../screens/AlertsScreen";
import ApprovalDetailScreen from "../screens/ApprovalDetailScreen";
import OrderDetailScreen from "../screens/OrderDetailScreen";
import ScanScreen from "../screens/ScanScreen";
import RootTabs from "./RootTabs";

const Stack = createNativeStackNavigator();

export default function AppNavigator() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="Tabs" component={RootTabs} />
      <Stack.Screen name="ApprovalDetail" component={ApprovalDetailScreen} />
      <Stack.Screen name="OrderDetail" component={OrderDetailScreen} />
      <Stack.Screen name="Alerts" component={AlertsScreen} />
      <Stack.Screen name="Adjust" component={AdjustScreen} />
      <Stack.Screen name="Scan" component={ScanScreen} options={{ presentation: "fullScreenModal" }} />
    </Stack.Navigator>
  );
}
