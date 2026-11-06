// ---------------------------------------------------------------------------
// What Obsidian does not update when something is renamed: the paths in views,
// schema and settings. Links in notes are its own job.
// ---------------------------------------------------------------------------

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const withoutExtension = (path: string) => path.replace(/\.md$/, "");
const nameOf = (path: string) => withoutExtension(path).split("/").pop()!;

/** A folder inside the settings or a view keeps its place under the new path. */
function moved(path: string, oldFolder: string, newFolder: string): string {
  return path === oldFolder || path.startsWith(`${oldFolder}/`) ? newFolder + path.slice(oldFolder.length) : path;
}

/** inFolder("…"), file("…") and link("…") in a view. */
export function updateView(text: string, oldPath: string, newPath: string, isFolder: boolean): string {
  const pairs = isFolder
    ? [[oldPath, newPath]]
    : [[oldPath, newPath], [withoutExtension(oldPath), withoutExtension(newPath)], [nameOf(oldPath), nameOf(newPath)]];
  return pairs.reduce(
    (result, [from, to]) =>
      result.replace(new RegExp(`(\\b(?:inFolder|file|link)\\(\\s*(["']))${escapeRegExp(from)}(?=\\2|/)`, "g"), (_, call) => call + to),
    text
  );
}

/** `folder:` lines and the lists of folders of the schema. */
export function updateSchema(text: string, oldFolder: string, newFolder: string): string {
  return text
    .replace(/^(\s*folder:\s*)(\S+)/gm, (_, key, path) => key + moved(path, oldFolder, newFolder))
    .replace(/^((?:content|free)_folders:\s*\[)([^\]]*)/gm, (_, key, list: string) =>
      key + list.split(",").map((item) => moved(item.trim(), oldFolder, newFolder)).join(", ")
    );
}

/** A folder as a quoted value in a JSON settings file. */
export function updateSettings(text: string, oldFolder: string, newFolder: string): string {
  return text.replace(new RegExp(`"${escapeRegExp(oldFolder)}(?="|/)`, "g"), () => `"${newFolder}`);
}
