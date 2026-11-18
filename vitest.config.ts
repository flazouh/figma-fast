import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [
    {
      name: "assets-as-text",
      enforce: "pre",
      transform(code, id) {
        if (/\/assets\/[^/]+\.mjs$/.test(id)) return { code: `export default ${JSON.stringify(code)}`, map: null }
        return undefined
      },
    },
  ],
  test: { include: ["test/**/*.test.ts"], pool: "threads", globalSetup: ["test/global-setup.ts"] },
})
