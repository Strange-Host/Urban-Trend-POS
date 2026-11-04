import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useTheme, { setThemePreference, resolveTheme } from './useTheme';

beforeEach(() => { setThemePreference('system'); localStorage.clear(); });

describe('useTheme', () => {
  it('defaults to following the device and stores nothing', () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.preference).toBe('system');
    expect(localStorage.getItem('ut_theme')).toBeNull();
  });

  it('applies and remembers an explicit choice', () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setPreference('dark'));
    expect(result.current.resolved).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('ut_theme')).toBe('dark');
    act(() => result.current.setPreference('light'));
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('going back to the device setting clears the stored choice', () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setPreference('dark'));
    act(() => result.current.setPreference('system'));
    expect(localStorage.getItem('ut_theme')).toBeNull();
    expect(['light', 'dark']).toContain(resolveTheme());
  });

  it('ignores a junk value', () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setPreference('purple'));
    expect(result.current.preference).toBe('system');
  });
});
