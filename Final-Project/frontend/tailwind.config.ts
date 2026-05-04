import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        display: ["'Space Grotesk'", "Inter", "sans-serif"],
      },
      colors: {
        // Slate-leaning paper palette for the light theme.
        paper:   "#f7f9fc",
        surface: "#ffffff",
        line:    "#e6ebf3",
        muted:   "#5b6b85",
        ink: {
          900: "#0f172a",
          800: "#111827",
          700: "#1f2937",
          600: "#334155",
          500: "#475569",
          400: "#64748b",
          300: "#94a3b8",
          200: "#cbd5e1",
          100: "#e2e8f0",
          50:  "#f1f5f9",
        },
        brand: {
          50:  "#eff6ff",
          100: "#dbeafe",
          200: "#bfdbfe",
          300: "#93c5fd",
          400: "#60a5fa",
          500: "#3b82f6",
          600: "#2563eb",
          700: "#1d4ed8",
          800: "#1e40af",
          900: "#1e3a8a",
        },
        accent: {
          400: "#22d3ee",
          500: "#06b6d4",
          600: "#0891b2",
        },
        warning: "#f59e0b",
        success: "#10b981",
        danger:  "#ef4444",
      },
      boxShadow: {
        card:   "0 1px 2px rgba(15,23,42,0.04), 0 6px 16px -8px rgba(15,23,42,0.08)",
        cardLg: "0 1px 2px rgba(15,23,42,0.04), 0 12px 32px -12px rgba(15,23,42,0.10)",
        glow:   "0 8px 30px -10px rgba(37,99,235,0.45)",
      },
      backgroundImage: {
        "hero-soft":
          "radial-gradient(60rem 30rem at 0% -10%, rgba(59,130,246,0.10), transparent 70%), radial-gradient(40rem 20rem at 100% 0%, rgba(6,182,212,0.10), transparent 70%)",
      },
    },
  },
  plugins: [],
};

export default config;
