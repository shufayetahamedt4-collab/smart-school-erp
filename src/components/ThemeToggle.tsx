"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

/** PRD §14.2 — dark mode toggle persisted to localStorage (html[data-theme]). */
export function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem("theme") === "dark";
    const prefers = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
    setDark(stored || (!!prefers && localStorage.getItem("theme") !== "light"));
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    localStorage.setItem("theme", dark ? "dark" : "light");
  }, [dark]);

  return (
    <button
      onClick={() => setDark((d) => !d)}
      className="rounded-lg p-2 text-slate-500 transition hover:bg-slate-100"
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
      aria-label="Toggle dark mode"
    >
      {dark ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  );
}
