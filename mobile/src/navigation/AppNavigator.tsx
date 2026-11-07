import { createNativeStackNavigator } from "@react-navigation/native-stack";
import React from "react";
import AdjustScreen from "../screens/AdjustScreen";
import AlertsScreen from "../screens/AlertsScreen";
import ApprovalDetailScreen from "../screens/ApprovalDetailScreen";
import OrderDetailScreen from "../screens/OrderDetailScreen";
import ScanScreen from "../screens/ScanScreen";
import CatalogScreen from "../screens/v11/CatalogScreen";
import ProductEditScreen from "../screens/v11/ProductEditScreen";
import CategoriesScreen from "../screens/v11/CategoriesScreen";
import BulkPriceScreen from "../screens/v11/BulkPriceScreen";
import PriceHistoryScreen from "../screens/v11/PriceHistoryScreen";
import StockTakesScreen from "../screens/v11/StockTakesScreen";
import StockTakeCountScreen from "../screens/v11/StockTakeCountScreen";
import StockTakeDetailScreen from "../screens/v11/StockTakeDetailScreen";
import PaymentsScreen from "../screens/v11/PaymentsScreen";
import PaymentMatchScreen from "../screens/v11/PaymentMatchScreen";
import CouriersScreen from "../screens/v11/CouriersScreen";
import RemittanceScreen from "../screens/v11/RemittanceScreen";
import MyOrdersScreen from "../screens/v2/MyOrdersScreen";
import ConfirmOrderScreen from "../screens/v2/ConfirmOrderScreen";
import MyLeadsScreen from "../screens/v2/MyLeadsScreen";
import LeadDetailScreen from "../screens/v2/LeadDetailScreen";
import ReturnsScreen from "../screens/v2/ReturnsScreen";
import AttendanceScreen from "../screens/v11/AttendanceScreen";
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
      <Stack.Screen name="Catalog" component={CatalogScreen} />
      <Stack.Screen name="ProductEdit" component={ProductEditScreen} />
      <Stack.Screen name="Categories" component={CategoriesScreen} />
      <Stack.Screen name="BulkPrice" component={BulkPriceScreen} />
      <Stack.Screen name="PriceHistory" component={PriceHistoryScreen} />
      <Stack.Screen name="StockTakes" component={StockTakesScreen} />
      <Stack.Screen name="StockTakeCount" component={StockTakeCountScreen} />
      <Stack.Screen name="StockTakeDetail" component={StockTakeDetailScreen} />
      <Stack.Screen name="Payments" component={PaymentsScreen} />
      <Stack.Screen name="PaymentMatch" component={PaymentMatchScreen} />
      <Stack.Screen name="Couriers" component={CouriersScreen} />
      <Stack.Screen name="Remittance" component={RemittanceScreen} />
      <Stack.Screen name="Attendance" component={AttendanceScreen} />
      <Stack.Screen name="MyOrders" component={MyOrdersScreen} />
      <Stack.Screen name="ConfirmOrder" component={ConfirmOrderScreen} />
      <Stack.Screen name="MyLeads" component={MyLeadsScreen} />
      <Stack.Screen name="LeadDetail" component={LeadDetailScreen} />
      <Stack.Screen name="Returns" component={ReturnsScreen} />
      <Stack.Screen name="Scan" component={ScanScreen} options={{ presentation: "fullScreenModal" }} />
    </Stack.Navigator>
  );
}
