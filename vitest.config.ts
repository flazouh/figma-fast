import { defineConfig } from "vitest/config"

export default defineConfig({
  // Bun embeds the page scripts with `with { type: "text" }`; Vite ignores the attribute, so this gives tests the text.
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
  test: { include: ["test/**/*.test.ts"], pool: "threads", testTimeout: 20_000 },
})
