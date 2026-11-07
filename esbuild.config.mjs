// Builds the plugin into dist/. With VAULT_PLUGIN_DIR set, also installs it in
// that folder of a vault (main.js and manifest.json).
import esbuild from "esbuild";
import { copyFileSync, mkdirSync } from "fs";

await esbuild.build({
  entryPoints: ["main.ts"],
  bundle: true,
  // Node's modules: present in Obsidian for desktop, loaded only by the calendar commands.
  external: ["obsidian", "net", "os"],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  outfile: "dist/main.js",
});

const target = process.env.VAULT_PLUGIN_DIR;
if (target) {
  mkdirSync(target, { recursive: true });
  copyFileSync("dist/main.js", `${target}/main.js`);
  copyFileSync("manifest.json", `${target}/manifest.json`);
  console.log(`installed in ${target}`);
}
