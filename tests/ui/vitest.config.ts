import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: {
    alias: {
      "@gravity-ui/navigation": fileURLToPath(
        new URL(
          "../../node_modules/@gravity-ui/navigation/build/esm/index.js",
          import.meta.url,
        ),
      ),
      "@runoza/ui": fileURLToPath(
        new URL("../../packages/ui/src/index.ts", import.meta.url),
      ),
      "@runoza/api-client": fileURLToPath(
        new URL("../../packages/api-client/src/index.ts", import.meta.url),
      ),
      "@runoza/contracts": fileURLToPath(
        new URL("../../packages/contracts/src/index.ts", import.meta.url),
      ),
    },
  },
  plugins: [react()],
  test: {
    testTimeout: 15000,
    maxWorkers: 2,
    environment: "jsdom",
    server: { deps: { inline: [/@gravity-ui/, /@bem-react/] } },
    include: ["tests/ui/**/*.test.tsx"],
    setupFiles: ["tests/ui/setup.ts"],
  },
});
