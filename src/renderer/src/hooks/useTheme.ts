import { useCallback, useEffect, useState } from "react";

export type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "s3ream-theme";
const DARK_THEME = "s3reamdark";
const LIGHT_THEME = "s3ream";

const readStoredPreference = (): ThemePreference => {
  if (typeof window === "undefined") {
    return "system";
  }
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark" || stored === "system") {
    return stored;
  }
  return "system";
};

const applyTheme = (preference: ThemePreference) => {
  const dark =
    preference === "dark" ||
    (preference === "system" &&
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.setAttribute("data-theme", dark ? DARK_THEME : LIGHT_THEME);
};

/**
 * Theme preference ("system" | "light" | "dark") persisted in localStorage.
 * Applies `data-theme` on <html> and tracks the OS scheme live while the
 * preference is "system".
 */
export const useTheme = () => {
  const [preference, setPreferenceState] = useState<ThemePreference>(readStoredPreference);

  useEffect(() => {
    applyTheme(preference);
    if (preference !== "system") {
      return;
    }
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = () => applyTheme("system");
    mediaQuery.addEventListener("change", listener);
    return () => mediaQuery.removeEventListener("change", listener);
  }, [preference]);

  const setPreference = useCallback((next: ThemePreference) => {
    window.localStorage.setItem(STORAGE_KEY, next);
    setPreferenceState(next);
  }, []);

  return { preference, setPreference };
};
