const sharedRadii = {
  "--rounded-box": "1rem",
  "--rounded-btn": "0.625rem",
  "--rounded-badge": "9999px",
  "--border-btn": "1px",
  "--btn-text-case": "none",
  "--animation-btn": "0.1s",
  "--btn-focus-scale": "0.98",
};

module.exports = {
  darkMode: ["class", '[data-theme="dark"]'],
  content: ["./src/renderer/index.html", "./src/renderer/src/**/*.{ts,tsx,html}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "system-ui", "-apple-system", "sans-serif"],
      },
    },
  },
  plugins: [require("daisyui")],
  daisyui: {
    themes: [
      {
        s3ream: {
          "base-100": "#FFFFFF",
          "base-200": "#FAFAFA",
          "base-300": "#E5E5E5",
          "base-content": "#0A0A0A",
          primary: "#0A0A0A",
          "primary-content": "#FFFFFF",
          secondary: "#F0F0F0",
          "secondary-content": "#0A0A0A",
          accent: "#0A0A0A",
          neutral: "#0A0A0A",
          info: "#4E80EE",
          success: "#2DA44E",
          warning: "#E5A13D",
          error: "#E5484D",
          ...sharedRadii,
        },
      },
      {
        s3reamdark: {
          "base-100": "#141414",
          "base-200": "#0A0A0A",
          "base-300": "#262626",
          "base-content": "#FAFAFA",
          primary: "#FAFAFA",
          "primary-content": "#0A0A0A",
          secondary: "#1F1F1F",
          "secondary-content": "#FAFAFA",
          accent: "#FAFAFA",
          neutral: "#FAFAFA",
          info: "#5E9BFF",
          success: "#46A758",
          warning: "#F5A623",
          error: "#E5484D",
          ...sharedRadii,
        },
      },
    ],
    darkTheme: "s3reamdark",
  },
};
