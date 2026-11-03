import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import React, { useState } from "react";
import { Shell } from "../components/Shell";
import ApprovalsScreen from "../screens/ApprovalsScreen";
import DashboardScreen from "../screens/DashboardScreen";
import HomeScreen from "../screens/HomeScreen";
import MoreScreen from "../screens/MoreScreen";
import OrdersScreen from "../screens/OrdersScreen";
import StockScreen from "../screens/StockScreen";

const Tab = createBottomTabNavigator();

// The screens are still a tab navigator underneath (that keeps deep links, params and screen state working), but
// the tab bar is gone: navigation is the website's top bar and slide-in menu, drawn by <Shell>.
export default function RootTabs() {
  const [active, setActive] = useState("Home");
  return (
    <Shell active={active}>
      <Tab.Navigator
        initialRouteName="Home"
        tabBar={() => null}
        screenOptions={{ headerShown: false }}
        screenListeners={({ route }) => ({ focus: () => setActive(route.name) })}
      >
        <Tab.Screen name="Home" component={HomeScreen} />
        <Tab.Screen name="Dashboard" component={DashboardScreen} />
        <Tab.Screen name="Approvals" component={ApprovalsScreen} />
        <Tab.Screen name="Stock" component={StockScreen} />
        <Tab.Screen name="Orders" component={OrdersScreen} />
        <Tab.Screen name="More" component={MoreScreen} />
      </Tab.Navigator>
    </Shell>
  );
}
