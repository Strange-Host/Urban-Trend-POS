import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import type { HomeAttention, HomeSummary, SessionUser } from "../api/types";

// The refresh token lives only in the Android Keystore (SecureStore).
const K_REFRESH = "ut.refresh.v1";
const K_PROFILE = "ut.profile.v1";
const K_HOME = "ut.home.cache.v1";

export interface StoredProfile {
  user: SessionUser;
  autoLockSeconds: number;
}

export const secure = {
  async saveRefresh(token: string) {
    await SecureStore.setItemAsync(K_REFRESH, token);
  },
  async loadRefresh() {
    return SecureStore.getItemAsync(K_REFRESH);
  },
  async saveProfile(p: StoredProfile) {
    await SecureStore.setItemAsync(K_PROFILE, JSON.stringify(p));
  },
  async loadProfile(): Promise<StoredProfile | null> {
    const raw = await SecureStore.getItemAsync(K_PROFILE);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as StoredProfile;
    } catch {
      return null;
    }
  },
  async clear() {
    await SecureStore.deleteItemAsync(K_REFRESH);
    await SecureStore.deleteItemAsync(K_PROFILE);
  },
};

export interface HomeCache {
  userId: number;
  savedAt: string;
  attention: HomeAttention;
  summary: HomeSummary;
}

export const homeCache = {
  async save(c: HomeCache) {
    await AsyncStorage.setItem(K_HOME, JSON.stringify(c));
  },
  async load(userId: number): Promise<HomeCache | null> {
    const raw = await AsyncStorage.getItem(K_HOME);
    if (!raw) return null;
    try {
      const c = JSON.parse(raw) as HomeCache;
      return c.userId === userId ? c : null;
    } catch {
      return null;
    }
  },
  async clear() {
    await AsyncStorage.removeItem(K_HOME);
  },
};
