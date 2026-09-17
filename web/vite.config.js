import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  // Đặt base để deploy dưới một sub-path (vd GitHub Pages: /termez/). Đổi nếu cần.
  base: "./",
});
