import esbuild from "esbuild";

const isProd = process.argv[2] === "production";

const HOST_IMPORT_MAP = {
  "sillytavern/script": "../../../../../script.js",
  "sillytavern/extensions": "../../../../extensions.js",
  "sillytavern/i18n": "../../../../i18n.js",
  "sillytavern/secrets": "../../../../secrets.js",
};

const sillyTavernHostPlugin = {
  name: "sillytavern-host-externals",
  setup(build) {
    build.onResolve({ filter: /^sillytavern\// }, (args) => {
      const target = HOST_IMPORT_MAP[args.path];
      if (!target) {
        throw new Error(`Unknown SillyTavern host module: ${args.path}`);
      }
      return { path: target, external: true };
    });
  },
};

// SillyTavern loads /scripts/extensions/third-party/sillytavern-voice-mode/dist/index.js
// directly as an ES module without running npm install. Bundle all shared @voice-mode/*
// packages inline and rewrite sillytavern/* specifiers to exact runtime relative URLs.
const context = await esbuild.context({
  entryPoints: ["src/index.ts"],
  bundle: true,
  outfile: "dist/index.js",
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: isProd ? false : "inline",
  minify: false,
  logLevel: "info",
  plugins: [sillyTavernHostPlugin],
});

if (isProd) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
