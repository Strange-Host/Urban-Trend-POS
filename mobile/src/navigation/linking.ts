import { createNavigationContainerRef } from "@react-navigation/native";
import { parseDeepLink, type DeepTarget } from "../lib/deeplink";

export const navigationRef = createNavigationContainerRef<any>();

export function goTo(nav: { navigate: (...a: any[]) => void }, t: DeepTarget) {
  switch (t.kind) {
    case "tab":
      nav.navigate("Tabs", { screen: t.tab, params: t.params });
      break;
    case "approval":
      nav.navigate("ApprovalDetail", { id: t.id });
      break;
    case "order":
      nav.navigate("OrderDetail", { id: t.id });
      break;
    case "alerts":
      nav.navigate("Alerts");
      break;
  }
}

/** Returns false when the link points at a screen that does not exist yet. */
export function openDeepLink(nav: { navigate: (...a: any[]) => void }, link: string): boolean {
  const t = parseDeepLink(link);
  if (!t) return false;
  goTo(nav, t);
  return true;
}
