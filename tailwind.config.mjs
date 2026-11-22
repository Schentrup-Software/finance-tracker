/** @type {import('tailwindcss').Config} */

// Palette from Schentrup-Software/toddler-games (site/css/base.css): soft pastel
// fills, each with a deeper edge colour used for the chunky bottom shadow.
const hue = (c, deep) => ({ DEFAULT: c, deep });

export default {
  content: ["./app/**/*.{js,jsx,ts,tsx}"],
  // Hue classes are built from data (`c-${envelope.color}`), so keep them all.
  safelist: [{ pattern: /^c-(coral|peach|butter|mint|aqua|sky|lilac|pink|white)$/ }],
  theme: {
    extend: {
      colors: {
        bg: "#fff7ee",
        ink: { DEFAULT: "#6a5d7b", soft: "#8f84a0", faint: "#b9b0c6" },
        coral: hue("#ffb8b8", "#f08f8f"),
        peach: hue("#ffd3a8", "#f2ae72"),
        butter: hue("#fff1a6", "#ebcb5a"),
        mint: hue("#beebc8", "#86ce9a"),
        aqua: hue("#b4e9e6", "#7ccdc8"),
        sky: hue("#bbdcff", "#86b8f0"),
        lilac: hue("#d8c8f8", "#ae98e4"),
        pink: hue("#ffc9e3", "#f29cc4"),
      },
      fontFamily: {
        sans: [
          "Nunito", "ui-rounded", "SF Pro Rounded", "Quicksand", "Varela Round",
          "Arial Rounded MT Bold", "system-ui", "sans-serif",
        ],
      },
      borderRadius: {
        blob: "38px",
      },
    },
  },
  plugins: [],
};
