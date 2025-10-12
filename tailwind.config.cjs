const daisyThemes = require("daisyui/src/theming/themes");

module.exports = {
  darkMode: ["class", '[data-theme="dark"]'],
  content: ["./src/renderer/index.html", "./src/renderer/src/**/*.{ts,tsx,html}"],
  theme: {
    extend: {}
  },
  plugins: [require("daisyui")],
  daisyui: {
    themes: [
      {
        mkpblue: {
          ...daisyThemes["corporate"],
          primary: "#1d4ed8",
          "primary-focus": "#1e40af",
          "primary-content": "#ffffff",
          accent: "#2563eb"
        }
      },
      {
        mkpbluedark: {
          ...daisyThemes["business"],
          primary: "#3b82f6",
          "primary-focus": "#1d4ed8",
          "primary-content": "#0b1220",
          accent: "#1e3a8a",
          info: "#0ea5e9"
        }
      }
    ],
    darkTheme: "mkpbluedark"
  }
};
