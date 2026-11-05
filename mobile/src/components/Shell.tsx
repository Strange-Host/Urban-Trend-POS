import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Animated, BackHandler, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../api";
import { useAuth } from "../auth/AuthContext";
import { can } from "../lib/permissions";
import { GROUPS, PINNED_TOP, type MenuItem } from "../navigation/menu";
import { navigationRef } from "../navigation/linking";
import { MIN_TOUCH, colors } from "../theme";

/** True for screens drawn inside the shell (top bar + menu), so Header skips its own dark status area. */
export const ShellContext = createContext(false);

interface ShellApi {
  openMenu: () => void;
  closeMenu: () => void;
}
const MenuContext = createContext<ShellApi>({ openMenu: () => {}, closeMenu: () => {} });
export const useMenu = () => useContext(MenuContext);

const K_COLLAPSED = "ut.nav.collapsed.v1";

/**
 * The same layout the website shows on a phone: a dark top bar (menu button, name, notification bell) and a
 * slide-in menu grouped Sell / Stock / Money, instead of tabs along the bottom of the screen.
 */
export function Shell({ active, children }: { active: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const menu = useMemo<ShellApi>(() => ({ openMenu: () => setOpen(true), closeMenu: () => setOpen(false) }), []);
  return (
    <MenuContext.Provider value={menu}>
      <ShellContext.Provider value>
        <View style={{ flex: 1, backgroundColor: colors.paper }}>
          <TopBar active={active} />
          <View style={{ flex: 1 }}>{children}</View>
          <Drawer open={open} active={active} onClose={() => setOpen(false)} />
        </View>
      </ShellContext.Provider>
    </MenuContext.Provider>
  );
}

function TopBar({ active }: { active: string }) {
  const insets = useSafeAreaInsets();
  const { openMenu } = useMenu();
  const { request, offline } = useAuth();
  const [unread, setUnread] = useState(0);

  // Unread count for the bell: refreshed when the page changes and once a minute. Failures just keep the last count.
  const load = useCallback(async () => {
    try {
      const page = await request((t) => api.notifications(t));
      setUnread(page.items.filter((n) => !n.read).length);
    } catch {
      /* offline or signed out: the auth layer deals with it */
    }
  }, [request]);
  useEffect(() => {
    load();
  }, [load, active]);
  useEffect(() => {
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load]);

  return (
    <View style={[s.bar, { paddingTop: insets.top, height: 56 + insets.top }]}>
      <Pressable
        onPress={openMenu}
        accessibilityRole="button"
        accessibilityLabel="Open navigation menu"
        hitSlop={8}
        style={s.barBtn}
      >
        <Text style={s.hamburger}>☰</Text>
      </Pressable>
      <View style={{ alignItems: "center" }}>
        <Text style={s.brand}>Urban Trends</Text>
        {offline ? <Text style={s.offline}>Offline</Text> : null}
      </View>
      <Pressable
        onPress={() => navigationRef.isReady() && navigationRef.navigate("Alerts")}
        accessibilityRole="button"
        accessibilityLabel={unread > 0 ? `Alerts, ${unread} unread` : "Alerts"}
        hitSlop={8}
        style={s.barBtn}
      >
        <Text style={s.bell}>🔔</Text>
        {unread > 0 ? (
          <View style={s.badge}>
            <Text style={s.badgeText}>{unread > 99 ? "99+" : unread}</Text>
          </View>
        ) : null}
      </Pressable>
    </View>
  );
}

function Drawer({ open, active, onClose }: { open: boolean; active: string; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const drawerW = Math.min(300, Math.round(width * 0.82));
  const { user, signOut, lockNow } = useAuth();
  const progress = useRef(new Animated.Value(0)).current;
  const [mounted, setMounted] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  useEffect(() => {
    AsyncStorage.getItem(K_COLLAPSED)
      .then((raw) => raw && setCollapsed(new Set(JSON.parse(raw) as string[])))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (open) {
      setMounted(true);
      Animated.timing(progress, { toValue: 1, duration: 200, useNativeDriver: true }).start();
    } else {
      Animated.timing(progress, { toValue: 0, duration: 160, useNativeDriver: true }).start(({ finished }) => {
        if (finished) setMounted(false);
      });
    }
  }, [open, progress]);

  // Android back closes the menu first, like the website's scrim.
  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [open, onClose]);

  const visible = (items: MenuItem[]) => items.filter((i) => !i.perm || can(user, i.perm));
  const activeGroup = GROUPS.find((g) => g.items.some((i) => i.screen === active))?.id;

  function toggle(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      AsyncStorage.setItem(K_COLLAPSED, JSON.stringify([...next])).catch(() => {});
      return next;
    });
  }

  function go(item: MenuItem) {
    if (!item.screen && !item.route) return; // not built in the app yet
    onClose();
    if (!navigationRef.isReady()) return;
    if (item.route) (navigationRef as any).navigate(item.route);
    else navigationRef.navigate("Tabs", { screen: item.screen });
  }

  if (!mounted) return null;
  const translateX = progress.interpolate({ inputRange: [0, 1], outputRange: [-drawerW, 0] });

  const Item = ({ item, nested }: { item: MenuItem; nested?: boolean }) => {
    const isActive = !!item.screen && item.screen === active;
    const soon = !item.screen && !item.route;
    return (
      <Pressable
        onPress={() => go(item)}
        disabled={soon}
        accessibilityRole="menuitem"
        accessibilityState={{ selected: isActive, disabled: soon }}
        style={[s.item, nested && { paddingLeft: 28 }, isActive && s.itemActive]}
      >
        <Text style={[s.icon, isActive && { color: colors.ink }, soon && { opacity: 0.35 }]}>{item.icon}</Text>
        <Text style={[s.itemText, isActive && s.itemTextActive, soon && { opacity: 0.35 }]}>{item.label}</Text>
        {soon ? <Text style={s.soon}>Soon</Text> : null}
      </Pressable>
    );
  };

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: colors.scrim, opacity: progress }]}>
        <Pressable style={{ flex: 1 }} onPress={onClose} accessibilityLabel="Close navigation menu" accessibilityRole="button" />
      </Animated.View>
      <Animated.View
        style={[s.drawer, { width: drawerW, paddingTop: insets.top, paddingBottom: insets.bottom, transform: [{ translateX }] }]}
      >
        <View style={s.drawerHead}>
          <View>
            <Text style={s.drawerBrand}>Urban Trends</Text>
            <Text style={s.drawerSub}>Main Branch</Text>
          </View>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close navigation menu" hitSlop={10} style={s.barBtn}>
            <Text style={{ color: "rgba(255,255,255,0.6)", fontSize: 18 }}>✕</Text>
          </Pressable>
        </View>

        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12 }}>
          {visible(PINNED_TOP).map((i) => (
            <Item key={i.label} item={i} />
          ))}
          {GROUPS.map((g) => {
            const items = visible(g.items);
            if (items.length === 0) return null;
            const isOpen = !collapsed.has(g.id) || activeGroup === g.id;
            return (
              <View key={g.id} style={{ marginTop: 18 }}>
                <Pressable onPress={() => toggle(g.id)} accessibilityRole="button" accessibilityState={{ expanded: isOpen }} style={s.groupBtn}>
                  <Text style={s.groupText}>{g.label}</Text>
                  <Text style={s.groupArrow}>{isOpen ? "▾" : "▸"}</Text>
                </Pressable>
                {isOpen ? items.map((i) => <Item key={i.label} item={i} nested />) : null}
              </View>
            );
          })}
        </ScrollView>

        <View style={s.footer}>
          <View style={{ paddingHorizontal: 12, paddingVertical: 8 }}>
            <Text style={s.userName}>{user?.name}</Text>
            <Text style={s.userRole}>{user?.role}</Text>
          </View>
          <FooterLink
            label="Security & devices"
            onPress={() => {
              onClose();
              navigationRef.isReady() && navigationRef.navigate("Tabs", { screen: "More" });
            }}
          />
          <FooterLink
            label="Lock screen"
            onPress={() => {
              onClose();
              lockNow();
            }}
          />
          <FooterLink label="Sign out" onPress={() => void signOut()} />
        </View>
      </Animated.View>
    </View>
  );
}

function FooterLink({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={s.footLink}>
      <Text style={s.footLinkText}>{label}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  bar: {
    backgroundColor: colors.ink,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 8,
  },
  barBtn: { width: MIN_TOUCH, height: MIN_TOUCH, alignItems: "center", justifyContent: "center" },
  hamburger: { color: "rgba(255,255,255,0.85)", fontSize: 22 },
  bell: { fontSize: 18 },
  brand: { color: "#fff", fontWeight: "700", fontSize: 14, letterSpacing: -0.2 },
  offline: { color: colors.amber, fontSize: 10, fontFamily: "monospace", textTransform: "uppercase" },
  badge: {
    position: "absolute",
    top: 6,
    right: 4,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: 9,
    backgroundColor: colors.amber,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: { fontSize: 10, fontWeight: "700", color: colors.ink },
  drawer: { position: "absolute", top: 0, bottom: 0, left: 0, backgroundColor: colors.ink },
  drawerHead: {
    paddingHorizontal: 20,
    paddingVertical: 18,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.1)",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  drawerBrand: { color: "#fff", fontWeight: "700", fontSize: 18 },
  drawerSub: { color: "rgba(255,255,255,0.5)", fontFamily: "monospace", fontSize: 12, marginTop: 2 },
  item: {
    minHeight: MIN_TOUCH,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 12,
    borderRadius: 10,
  },
  itemActive: { backgroundColor: colors.amber },
  icon: { width: 18, fontSize: 16, color: "rgba(255,255,255,0.7)", textAlign: "center" },
  itemText: { fontSize: 14, color: "rgba(255,255,255,0.75)", fontWeight: "500", flexShrink: 1 },
  itemTextActive: { color: colors.ink, fontWeight: "700" },
  soon: { marginLeft: "auto", fontSize: 10, fontFamily: "monospace", color: "rgba(255,255,255,0.35)", textTransform: "uppercase" },
  groupBtn: {
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
  },
  groupText: { fontSize: 11, fontFamily: "monospace", textTransform: "uppercase", letterSpacing: 1, color: "rgba(255,255,255,0.4)" },
  groupArrow: { fontSize: 10, color: "rgba(255,255,255,0.4)" },
  footer: { borderTopWidth: 1, borderTopColor: "rgba(255,255,255,0.1)", padding: 12 },
  userName: { color: "#fff", fontWeight: "600", fontSize: 14 },
  userRole: { color: "rgba(255,255,255,0.5)", fontSize: 12, textTransform: "capitalize" },
  footLink: { minHeight: 44, justifyContent: "center", paddingHorizontal: 12, borderRadius: 10 },
  footLinkText: { color: "rgba(255,255,255,0.65)", fontSize: 14 },
});
