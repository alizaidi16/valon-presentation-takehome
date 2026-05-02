import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url))
    }
  },
  test: {
    environment: "node",
    globals: true,
    server: {
      deps: {
        // Inline @google/genai so vi.mock() can intercept it reliably
        inline: ["@google/genai"]
      }
    }
  }
});
