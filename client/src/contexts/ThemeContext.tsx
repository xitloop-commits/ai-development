import React, { createContext, useContext, useEffect, useState } from "react";

/**
 * Three themes. `light` and `dark` (Obsidian Glow) are the originals; `slate`
 * is a second dark-family theme. All dark-family themes keep the `.dark` class
 * (so component `dark:` variants apply); the specific theme is distinguished by
 * a `data-theme` attribute — see index.css / index.html.
 */
export type Theme = "light" | "dark" | "slate";

const THEME_ORDER: Theme[] = ["light", "dark", "slate"];

interface ThemeContextType {
  theme: Theme;
  setTheme: (t: Theme) => void;
  /** Cycle light → dark → slate → light. */
  toggleTheme?: () => void;
  switchable: boolean;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

/** Apply a theme to <html>: the `.dark` class drives the component dark:
 *  variants, the `data-theme` attribute selects the specific palette. Kept in
 *  sync with the anti-flash script in index.html. */
function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "light") {
    root.classList.remove("dark");
    root.removeAttribute("data-theme");
  } else if (theme === "slate") {
    root.classList.add("dark");
    root.setAttribute("data-theme", "slate");
  } else {
    // dark (Obsidian Glow) — the default dark-family theme.
    root.classList.add("dark");
    root.removeAttribute("data-theme");
  }
}

interface ThemeProviderProps {
  children: React.ReactNode;
  defaultTheme?: Theme;
  switchable?: boolean;
}

export function ThemeProvider({
  children,
  defaultTheme = "light",
  switchable = false,
}: ThemeProviderProps) {
  const [theme, setTheme] = useState<Theme>(() => {
    if (switchable) {
      const stored = localStorage.getItem("theme");
      if (stored === "light" || stored === "dark" || stored === "slate") return stored;
    }
    return defaultTheme;
  });

  useEffect(() => {
    applyTheme(theme);
    if (switchable) localStorage.setItem("theme", theme);
  }, [theme, switchable]);

  const toggleTheme = switchable
    ? () => setTheme((prev) => THEME_ORDER[(THEME_ORDER.indexOf(prev) + 1) % THEME_ORDER.length])
    : undefined;

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme, switchable }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return context;
}
