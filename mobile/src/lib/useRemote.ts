import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useEffect, useRef, useState } from "react";
import { isApiError } from "../api/errors";
import { useAuth } from "../auth/AuthContext";
import { cache } from "./storage";

/**
 * Fetch-on-focus with a per-user offline cache. Cached data shows first, fresh data replaces it.
 * A network failure keeps the cached view (read-only offline); other errors surface in `error`.
 */
export function useRemote<T>(key: string, fetcher: (accessToken: string) => Promise<T>) {
  const { user, request } = useAuth();
  const [data, setData] = useState<T | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const keyRef = useRef(key);
  const fresh = useRef(false);
  const userId = user?.id;

  useEffect(() => {
    keyRef.current = key;
    fresh.current = false;
    setData(null);
    setSavedAt(null);
    setError(null);
    setLoading(true);
    if (userId === undefined) return;
    let alive = true;
    cache
      .get<T>(userId, key)
      .then((c) => {
        if (alive && c && !fresh.current) {
          setData(c.data);
          setSavedAt(c.savedAt);
          setLoading(false);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [userId, key]);

  const load = useCallback(async () => {
    if (userId === undefined) return;
    const myKey = key;
    try {
      const d = await request((t) => fetcherRef.current(t));
      if (keyRef.current !== myKey) return;
      fresh.current = true;
      setData(d);
      setSavedAt(new Date().toISOString());
      setError(null);
      cache.set(userId, myKey, d).catch(() => {});
    } catch (e) {
      if (keyRef.current !== myKey) return;
      if (!isApiError(e) || e.code !== "NETWORK") setError(isApiError(e) ? e.message : "Could not refresh");
    } finally {
      if (keyRef.current === myKey) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [userId, key, request]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const refresh = useCallback(() => {
    setRefreshing(true);
    load();
  }, [load]);

  return { data, savedAt, loading, refreshing, error, refresh, reload: load };
}
