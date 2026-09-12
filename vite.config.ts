import { sites } from "@openai/sites-vite-plugin";
import vinext from "vinext";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "site-creator-d1",
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
};

export default defineConfig(async ({ command }) => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  // Avoid importing it at all in dev: its local runtime can prevent Vinext
  // from accepting connections on Windows.
  const cloudflare =
    command === "build"
      ? (await import("@cloudflare/vite-plugin")).cloudflare
      : undefined;

  return {
    server: {
      // Vinext otherwise binds to IPv6 loopback on Windows, where its dev
      // socket can appear open but time out. Bind explicitly to IPv4 instead.
      host: "127.0.0.1",
      ...(isCodexSeatbeltSandbox
        ? { watch: { useFsEvents: false, usePolling: true } }
        : {}),
    },
    plugins: [
      vinext(),
      // The hosting integration is used by build tooling, not the local app.
      ...(command === "build" ? [sites()] : []),
      // The Cloudflare simulator is only needed for a production build. Loading
      // it under Vinext's local RSC dev server can leave port 3000 unable to
      // accept requests on Windows.
      ...(command === "build" && cloudflare
        ? [
            cloudflare({
              viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
              config: localBindingConfig,
            }),
          ]
        : []),
    ],
  };
});
