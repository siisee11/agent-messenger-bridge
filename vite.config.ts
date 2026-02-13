import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: "site",
  build: {
    outDir: "../dist-site",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: fromRoot("site/index.html"),
        "docs/index": fromRoot("site/docs/index.html"),
        "docs/getting-started": fromRoot("site/docs/getting-started.html"),
        "docs/cli-reference": fromRoot("site/docs/cli-reference.html"),
        "docs/discord-bot": fromRoot("site/docs/discord-bot.html"),
        "docs/release": fromRoot("site/docs/release.html"),
      },
    },
  },
});
