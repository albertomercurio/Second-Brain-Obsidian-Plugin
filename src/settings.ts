// The plugin's settings: where its files are and which property holds the type
// of a note. Edited in Obsidian's settings, saved in the plugin's data.json.

export interface Settings {
  /** YAML file with the types of notes and their properties. */
  schemaFile: string;
  /** Frontmatter property that holds the type of a note. */
  typeProperty: string;
  /** Folders left out of every check, link and count. */
  ignoredFolders: string[];
  /** Where `templates` writes the note templates; left out of the checks. */
  templatesFolder: string;
  /** Page of starting context for agents, rewritten after every change; empty: none. */
  briefingFile: string;
  /** Log of the plugin's changes to notes; its latest entries go in the briefing. */
  logFile: string;
  /** Questions with a known answer, solved through the links. */
  recallFile: string;
  /** Unix socket of the local calendar helper (desktop); empty: calendar commands off. */
  calendarSocket: string;
  /** The calendar account chosen last, offered first next time. */
  calendarAccount: string;
  /** New notes get the properties and body of their type's template once they have a type. */
  completeNewNotes: boolean;
  /** Health Auto Export folders and the vault folder of each one's data: "folder -> vault folder" (desktop). */
  healthSources: string[];
  /** Maximum heart rate for the zones and the training load; 0: the highest seen in a workout. */
  healthMaxHr: number;
  /** Sex, for the weighting of the training load (TRIMP). */
  healthSex: "male" | "female";
  /** Minutes between automatic imports; 0: only by command. */
  healthEvery: number;
}

/** A source of health data and the vault folder for its data. */
export interface HealthSource {
  folder: string;
  output: string;
}

export const DEFAULT_SETTINGS: Settings = {
  schemaFile: "Second Brain/schema.yaml",
  typeProperty: "type",
  ignoredFolders: [],
  templatesFolder: "Second Brain/Templates",
  briefingFile: "Second Brain/briefing.md",
  logFile: "Second Brain/log.md",
  recallFile: "Second Brain/recall.yaml",
  calendarSocket: "",
  calendarAccount: "",
  completeNewNotes: true,
  healthSources: [],
  healthMaxHr: 0,
  healthSex: "male",
  healthEvery: 60,
};

/** Saved settings over the defaults, without unknown keys or values of the wrong type. */
export function readSettings(saved: unknown): Settings {
  const data = (saved && typeof saved === "object" ? saved : {}) as Record<string, unknown>;
  const settings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    const value = data[key];
    if (key === "ignoredFolders") {
      if (Array.isArray(value)) settings.ignoredFolders = folderList(value.filter((item) => typeof item === "string").join("\n"));
    } else if (key === "completeNewNotes") {
      if (typeof value === "boolean") settings.completeNewNotes = value;
    } else if (key === "healthSources") {
      if (Array.isArray(value)) settings.healthSources = value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim());
    } else if (key === "healthMaxHr" || key === "healthEvery") {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) settings[key] = value;
    } else if (key === "healthSex") {
      if (value === "male" || value === "female") settings.healthSex = value;
    } else if (typeof value === "string") {
      settings[key] = value.trim();
    }
  }
  return settings;
}

/** The health sources of the settings: "folder -> vault folder", one a line; lines without both are left out. */
export function healthSources(lines: string[]): HealthSource[] {
  return lines.flatMap((line) => {
    const parts = line.split(/\s*(?:->|→)\s*/);
    if (parts.length !== 2) return [];
    const [folder, output] = [parts[0].trim(), parts[1].trim().replace(/^\/+|\/+$/g, "")];
    return folder && output ? [{ folder, output }] : [];
  });
}

/** Folders from text, one per line, without slashes at the ends. */
export function folderList(text: string): string[] {
  return [...new Set(text.split(/\r?\n/).map((line) => line.trim().replace(/^\/+|\/+$/g, "")).filter(Boolean))];
}

const inFolder = (path: string, folder: string): boolean => Boolean(folder) && (path === folder || path.startsWith(`${folder}/`));

/** Files the plugin does not read: hidden, dependencies, ignored folders, templates, the briefing it writes. */
export function isIgnored(path: string, settings: Settings): boolean {
  if (path.split("/").some((part) => part.startsWith(".") || part === "node_modules")) return true;
  return path === settings.briefingFile || [...settings.ignoredFolders, settings.templatesFolder].some((folder) => inFolder(path, folder));
}

/** The settings after a rename inside Obsidian, or null when no path in them changes. */
export function renamedSettings(settings: Settings, oldPath: string, newPath: string): Settings | null {
  const move = (path: string) => (inFolder(path, oldPath) ? newPath + path.slice(oldPath.length) : path);
  const next: Settings = {
    ...settings,
    schemaFile: move(settings.schemaFile),
    ignoredFolders: settings.ignoredFolders.map(move),
    templatesFolder: move(settings.templatesFolder),
    briefingFile: move(settings.briefingFile),
    logFile: move(settings.logFile),
    recallFile: move(settings.recallFile),
    healthSources: settings.healthSources.map((line) => {
      const [source] = healthSources([line]);
      return source ? `${source.folder} -> ${move(source.output)}` : line;
    }),
  };
  return JSON.stringify(next) === JSON.stringify(settings) ? null : next;
}
