// Notes as Obsidian writes them: the same YAML library, with the same layout.

import { stringify } from "yaml";
import type { Meta } from "./vault";

export function renderNote(meta: Meta, body: string): string {
  const yaml = stringify(meta, { lineWidth: 0, nullStr: "", aliasDuplicateObjects: false });
  return `---\n${yaml}---\n${body.replace(/^\n+/, "")}`;
}
