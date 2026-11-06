// Bundles tests/*.test.ts with esbuild and runs them with Node's built-in test runner.
import esbuild from "esbuild";
import { readdirSync, rmSync } from "fs";
import { spawnSync } from "child_process";

const outdir = "tests/.build";
rmSync(outdir, { recursive: true, force: true });
const entryPoints = readdirSync("tests").filter((f) => f.endsWith(".test.ts")).map((f) => `tests/${f}`);
// CommonJS dependencies (yaml) need `require` inside an ES module bundle.
const banner = { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" };
await esbuild.build({ entryPoints, bundle: true, platform: "node", format: "esm", outdir, outExtension: { ".js": ".mjs" }, external: ["obsidian"], banner, logLevel: "warning" });
const files = readdirSync(outdir).filter((f) => f.endsWith(".mjs")).map((f) => `${outdir}/${f}`);
const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
