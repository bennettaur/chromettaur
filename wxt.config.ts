import { defineConfig } from "wxt";

export default defineConfig({
  srcDir: ".",
  outDir: "dist",
  manifest: {
    name: "TabKit",
    description:
      "Auto-close inactive tabs, dedupe configured URLs, auto-group by URL.",
    version: "0.1.0",
    permissions: ["tabs", "tabGroups", "alarms", "storage"],
    action: {
      default_title: "TabKit",
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
  },
});
