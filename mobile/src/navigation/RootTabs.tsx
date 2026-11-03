import { createBottomTabNavigator, type BottomTabBarProps } from "@react-navigation/bottom-tabs";
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import HomeScreen from "../screens/HomeScreen";
import MoreScreen from "../screens/MoreScreen";
import PlaceholderScreen from "../screens/PlaceholderScreen";
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

const Approvals = () => (
  <PlaceholderScreen title="Approvals" note="Voids, refunds, requisitions and expenses arrive in the next step." />
);
const Stock = () => (
  <PlaceholderScreen title="Stock" note="Barcode scan, lookup and adjust arrive after approvals." />
);

export default function RootTabs() {
  return (
    <Tab.Navigator tabBar={(p) => <TabBar {...p} />} screenOptions={{ headerShown: false }}>
      <Tab.Screen name="Home" component={HomeScreen} />
      <Tab.Screen name="Approvals" component={Approvals} />
      <Tab.Screen name="Stock" component={Stock} />
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
