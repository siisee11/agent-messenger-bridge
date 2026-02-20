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
        "docs/slack-bot": fromRoot("site/docs/slack-bot.html"),
        "docs/release": fromRoot("site/docs/release.html"),
        "docs/ko/index": fromRoot("site/docs/ko/index.html"),
        "docs/ko/getting-started": fromRoot("site/docs/ko/getting-started.html"),
        "docs/ko/cli-reference": fromRoot("site/docs/ko/cli-reference.html"),
        "docs/ko/discord-bot": fromRoot("site/docs/ko/discord-bot.html"),
        "docs/ko/slack-bot": fromRoot("site/docs/ko/slack-bot.html"),
        "docs/ko/release": fromRoot("site/docs/ko/release.html"),
      },
    },
  },
});
