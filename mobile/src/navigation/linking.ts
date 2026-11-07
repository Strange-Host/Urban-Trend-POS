import { createNavigationContainerRef } from "@react-navigation/native";
import { entityTarget, parseDeepLink, type DeepTarget } from "../lib/deeplink";

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
    case "route":
      nav.navigate(t.name, t.params);
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

/** The same for a home-feed item's { type, id } link. */
export function openEntityLink(nav: { navigate: (...a: any[]) => void }, link: { type: string; id: number } | null): boolean {
  const t = link ? entityTarget(link.type, link.id) : null;
  if (!t) return false;
  goTo(nav, t);
  return true;
}
