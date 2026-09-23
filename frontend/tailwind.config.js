/** @type {import('tailwindcss').Config} */
const config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        // Alma unified design tokens (see app/globals.css). Flip via [data-theme="dark"].
        page: "var(--alma-bg)",
        surface: "var(--alma-surface)",
        "surface-sunken": "var(--alma-surface-sunken)",
        ink: "var(--alma-text)",
        muted: "var(--alma-text-muted)",
        rule: "var(--alma-border)",
        accent: "var(--alma-accent)",
        "accent-hover": "var(--alma-accent-hover)",
        "accent-soft": "var(--alma-accent-soft)",
        "on-accent": "var(--alma-on-accent)",
        success: "var(--alma-success)",
        danger: "var(--alma-danger)",
        warning: "var(--alma-warning)",
      },
    },
  },
  variants: {
    extend: {},
  },
  plugins: [],
};

export default config;
