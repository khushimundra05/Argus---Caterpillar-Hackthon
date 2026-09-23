import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        cat: { yellow: "#FFCD11", black: "#111111" },
      },
      keyframes: {
        flash: { "0%,100%": { opacity: "1" }, "50%": { opacity: "0.55" } },
      },
      animation: { flash: "flash 1s ease-in-out infinite" },
    },
  },
  plugins: [],
} satisfies Config;
