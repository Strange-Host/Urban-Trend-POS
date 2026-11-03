import Constants from "expo-constants";
import { createHttpApi } from "./http";
import { createMockApi } from "./mock/mockApi";
import type { Api } from "./types";

// Switch with app.json -> expo.extra.apiMode ("mock" | "http") and
// expo.extra.apiBaseUrl (e.g. "https://your-backend.up.railway.app").
const extra = (Constants.expoConfig?.extra ?? {}) as {
  apiMode?: "mock" | "http";
  apiBaseUrl?: string;
};

export const apiMode: "mock" | "http" =
  extra.apiMode === "http" && extra.apiBaseUrl ? "http" : "mock";
export const api: Api =
  apiMode === "http" ? createHttpApi(extra.apiBaseUrl as string) : createMockApi();
