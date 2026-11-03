import { createBottomTabNavigator, type BottomTabBarProps } from "@react-navigation/bottom-tabs";
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import ApprovalsScreen from "../screens/ApprovalsScreen";
import HomeScreen from "../screens/HomeScreen";
import MoreScreen from "../screens/MoreScreen";
import OrdersScreen from "../screens/OrdersScreen";
import StockScreen from "../screens/StockScreen";
import { colors } from "../theme";

const Tab = createBottomTabNavigator();

// Same look as the mockup: white bar, amber inset line on the active tab.
function TabBar({ state, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[s.bar, { paddingBottom: insets.bottom }]}>
      {state.routes.map((route, i) => {
        const active = state.index === i;
        return (
          <Pressable
            key={route.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            style={[s.tab, active && s.active]}
            onPress={() => {
              const e = navigation.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
              if (!active && !e.defaultPrevented) navigation.navigate(route.name);
            }}
          >
            <Text style={[s.label, active && s.labelActive]}>{route.name}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export default function RootTabs() {
  return (
    <Tab.Navigator tabBar={(p) => <TabBar {...p} />} screenOptions={{ headerShown: false }}>
      <Tab.Screen name="Home" component={HomeScreen} />
      <Tab.Screen name="Approvals" component={ApprovalsScreen} />
      <Tab.Screen name="Stock" component={StockScreen} />
      <Tab.Screen name="Orders" component={OrdersScreen} />
      <Tab.Screen name="More" component={MoreScreen} />
    </Tab.Navigator>
  );
}

const s = StyleSheet.create({
  bar: { flexDirection: "row", backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.line },
  tab: { flex: 1, minHeight: 56, alignItems: "center", justifyContent: "center" },
  active: { boxShadow: `inset 0 3px 0 ${colors.amber}` },
  label: { fontSize: 12, color: colors.muted },
  labelActive: { color: colors.ink, fontWeight: "700" },
});
