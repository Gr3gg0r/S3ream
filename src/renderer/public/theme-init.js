// Applies the stored theme before React mounts to avoid a flash of the wrong theme.
// Mirrors the logic in src/renderer/src/hooks/useTheme.ts — keep both in sync.
(function () {
  try {
    var stored = window.localStorage.getItem("hulesa-theme");
    if (stored !== "light" && stored !== "dark" && stored !== "system") {
      stored = "system";
    }
    var dark =
      stored === "dark" ||
      (stored === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.setAttribute("data-theme", dark ? "hulesadark" : "hulesa");
  } catch {
    // Fall back to the default theme declared on <html>.
  }
})();
