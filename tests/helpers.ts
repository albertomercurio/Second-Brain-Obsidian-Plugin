import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { Schema } from "../src/schema";
import { nfc } from "../src/text";
import { hasText, isVaultFile, Vault, type VaultFile } from "../src/vault";

export const schema = new Schema(parse(readFileSync("tests/fixtures/schema.yaml", "utf8")));

/** A vault from { path: text }. */
export function vaultOf(files: Record<string, string>): Vault {
  return new Vault(
    Object.entries(files).map(([path, text]) => ({ path, size: text.length, mtime: Date.parse("2026-10-20"), text: hasText(path) ? text : undefined })),
    parse
  );
}

export const note = (meta: string, body = ""): string => `---\n${meta}\n---\n${body}`;

/** The vault on disk, read as the plugin reads it inside Obsidian. */
export function vaultFromDisk(root: string): Vault {
  const read = (dir: string): VaultFile[] =>
    readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
      const real = dir ? `${dir}/${entry.name}` : entry.name;
      const path = nfc(real);
      if (!isVaultFile(entry.isDirectory() ? `${path}/` : path)) return [];
      if (entry.isDirectory()) return read(real);
      const { size, mtimeMs } = statSync(join(root, real));
      return [{ path, size, mtime: mtimeMs, text: hasText(path) ? readFileSync(join(root, real), "utf8") : undefined }];
    });
  return new Vault(read(""), parse);
}
