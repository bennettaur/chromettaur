import { defineConfig } from "wxt";

export default defineConfig({
  srcDir: ".",
  outDir: "dist",
  // `pnpm build:dev` lands in dist/chrome-mv3-local-dev, so it loads unpacked
  // as a separate extension (own ID and storage) next to a production build.
  // A custom mode, not "development", keeps WXT's dev-server reload client
  // and permissions out of the bundle.
  outDirTemplate: "{{browser}}-mv{{manifestVersion}}{{modeSuffix}}",
  manifest: ({ mode }) => ({
    name: mode === "local-dev" ? "Chromettaur (dev)" : "Chromettaur",
    description:
      "Auto-close inactive tabs, dedupe configured URLs, auto-group by URL, add custom request headers.",
    version: "0.2.0",
    permissions: [
      "tabs",
      "tabGroups",
      "alarms",
      "storage",
      "declarativeNetRequestWithHostAccess",
    ],
    // Custom request headers ask for access to each rule's site when the
    // rule is saved, instead of holding access to every site up front.
    optional_host_permissions: ["*://*/*"],
    action: {
      default_title: "Chromettaur",
    },
    commands: {
      "open-repo-switcher": {
        suggested_key: { default: "Alt+Shift+G" },
        description: "Open the GitHub repo switcher",
      },
      "open-tab-history": {
        suggested_key: { default: "Alt+Shift+H" },
        description: "Show recently viewed tabs",
      },
    },
  }),
});
