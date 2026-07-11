import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tradex/**/*.test.ts"],
  },
});
