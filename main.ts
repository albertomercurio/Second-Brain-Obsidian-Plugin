// The Second Brain plugin: checks the vault against its schema and keeps it
// consistent, inside Obsidian, on any device. Commands in the palette and in
// Obsidian's command line (`obsidian-cli second-brain:…`); lint and briefing
// redone after every change. The logic is in src/, which knows nothing of
// Obsidian: this file gives it the vault as Obsidian indexes it. On the Mac,
// the calendar commands talk to a local helper that holds the calendar permission.
// On desktop, the health import reads Health Auto Export's folders into data files.

import {
  App,
  type CachedMetadata,
  type CliData,
  type CliFlags,
  debounce,
  getLinkpath,
  Modal,
  Notice,
  parseFrontMatterAliases,
  parseYaml,
  Platform,
  Plugin,
  PluginSettingTab,
  type Reference,
  Setting,
  SuggestModal,
  TAbstractFile,
  TFile,
  TFolder,
} from "obsidian";
import { briefing } from "./src/briefing";
import { type CalendarEvent, type CalendarSpec, calendarSpec, type Draft, draftFromNote, eventId, eventPath, noteFromEvent, peopleByEmail } from "./src/calendar";
import { lintReport, linksReport, neighboursReport, pathReport, plural, recallReport } from "./src/commands";
import { callHelper, expandHome } from "./src/helper";
import { countBySeverity, type Issue, lint } from "./src/lint";
import { type RecallResult, runRecall } from "./src/recall";
import { updateSchema, updateSettings, updateView } from "./src/references";
import { ReportModal } from "./src/ReportModal";
import { Schema } from "./src/schema";
import { DEFAULT_SETTINGS, folderList, healthSources, isIgnored, readSettings, renamedSettings, type Settings } from "./src/settings";
import { addExport, changedFiles, derive, FILES, type ImportState, loadStore, minutesFile, newCounts, outputFiles, parseJsonl, readState, type SourceFile } from "./src/health";
import { completeNew, propertyTypes, templateFiles } from "./src/templates";
import { addDays, asDate, localDate } from "./src/text";
import { hasText, type IndexedFile, type IndexedLink, type Note, splitFrontmatter, Vault } from "./src/vault";

const NOTE_FLAGS: CliFlags = {
  file: { value: "<name>", description: "Note name or alias (default: the active note)" },
  path: { value: "<path>", description: "Note path" },
};

type Loaded = { schema: Schema; problem: Issue | null };

export default class SecondBrainPlugin extends Plugin {
  settings: Settings = { ...DEFAULT_SETTINGS };
  /** Renames run one at a time: moving a folder fires one event for each file inside. */
  private renames: Promise<void> = Promise.resolve();
  private status?: HTMLElement;
  /** Lint and briefing again, a few seconds after the last change. */
  private refresh = debounce(() => void this.run(() => this.refreshState()), 3000, true);
  /** The calendar rule of the schema, as of the last check: the palette shows the commands where they apply. */
  private calendar: CalendarSpec | null = null;
  /** Notes created since Obsidian started, until they have text: completed from their template once they have a type. */
  private fresh = new Set<string>();
  /** One health import at a time; a failed automatic one is announced once. */
  private importing = false;
  private importWarned = false;

  async onload(): Promise<void> {
    this.settings = readSettings(await this.loadData());
    this.addSettingTab(new SecondBrainSettingTab(this.app, this));
    this.status = this.addStatusBarItem();
    this.status.addClass("mod-clickable");
    this.status.setAttr("aria-label", "Check the vault");
    this.status.onClickEvent(() => void this.run(() => this.checkVault()));
    this.registerCli();
    this.app.workspace.onLayoutReady(() => {
      this.refresh();
      const changed = (file: TAbstractFile) => {
        if (file.path !== this.settings.briefingFile) this.refresh();
      };
      this.registerEvent(this.app.vault.on("create", changed));
      this.registerEvent(this.app.vault.on("modify", changed));
      this.registerEvent(this.app.vault.on("delete", changed));
      this.registerEvent(this.app.vault.on("rename", changed));
      // Links are read from Obsidian's index: check again once it has caught up.
      this.registerEvent(this.app.metadataCache.on("resolved", () => this.refresh()));
      // New notes: a view's New button writes the type after creating the file.
      this.registerEvent(
        this.app.vault.on("create", (file) => {
          if (file instanceof TFile && file.extension === "md" && this.settings.completeNewNotes) this.fresh.add(file.path);
        })
      );
      this.registerEvent(
        this.app.vault.on("rename", (file, oldPath) => {
          if (this.fresh.delete(oldPath)) this.fresh.add(file.path);
        })
      );
      this.registerEvent(
        this.app.metadataCache.on("changed", (file) => {
          if (this.fresh.has(file.path)) void this.run(() => this.completeNote(file));
        })
      );
      // Health data: shortly after start, then at the interval of the settings.
      if (this.healthReady()) {
        this.registerInterval(window.setTimeout(() => void this.autoImport(), 15000));
        if (this.settings.healthEvery > 0) this.registerInterval(window.setInterval(() => void this.autoImport(), this.settings.healthEvery * 60000));
      }
    });

    this.addCommand({
      id: "check-vault",
      name: "Check the vault",
      callback: () => void this.run(() => this.checkVault()),
    });
    this.addCommand({
      id: "conform-note",
      name: "Conform this note to its template",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) void this.run(() => this.conformActive(file));
        return true;
      },
    });
    this.addCommand({
      id: "health-import",
      name: "Import health data now",
      checkCallback: (checking) => {
        if (!this.healthReady()) return false;
        if (!checking) void this.run(async () => void new Notice(`Second Brain: ${await this.importHealth(true)}`, 10000));
        return true;
      },
    });
    this.addCommand({
      id: "calendar-add",
      name: "Add this event to the calendar",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const type = file && this.app.metadataCache.getFileCache(file)?.frontmatter?.[this.settings.typeProperty];
        if (!file || !this.calendarReady() || type !== this.calendar?.type) return false;
        if (!checking) void this.run(() => this.addToCalendar(file));
        return true;
      },
    });
    this.addCommand({
      id: "calendar-note",
      name: "New note from a calendar event",
      checkCallback: (checking) => {
        if (!this.calendarReady()) return false;
        if (!checking) void this.run(() => this.noteFromCalendar());
        return true;
      },
    });
    this.addCommand({
      id: "calendar-open",
      name: "Open this event in the calendar",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const link = file && this.calendar && this.app.metadataCache.getFileCache(file)?.frontmatter?.[this.calendar.link];
        if (typeof link !== "string" || !eventId(link)) return false;
        if (!checking) window.open(link);
        return true;
      },
    });
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        this.renames = this.renames.then(() => this.run(() => this.updateReferences(file, oldPath)));
      })
    );
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.refresh();
  }

  private async run(task: () => Promise<void>): Promise<void> {
    try {
      await task();
    } catch (err) {
      new Notice(`Second Brain: ${err instanceof Error ? err.message : err}`, 8000);
      console.error("[SecondBrain]", err);
    }
  }

  /** Where a link leads, as Obsidian resolves it. */
  private resolve(target: string, source: string): string | null {
    if (!target) return source;
    return this.app.metadataCache.getFirstLinkpathDest(target, source)?.path ?? null;
  }

  /** The links of a note from Obsidian's index: in properties with their key, in the body with their line. */
  private linksOf(file: TFile, cache: CachedMetadata | null): IndexedLink[] {
    const link = (ref: Reference): IndexedLink => {
      const target = getLinkpath(ref.link);
      return { target, resolved: this.resolve(target, file.path), original: ref.original };
    };
    const body = [...(cache?.links ?? []), ...(cache?.embeds ?? [])].sort((a, b) => a.position.start.offset - b.position.start.offset);
    return [
      ...(cache?.frontmatterLinks ?? []).map((ref) => ({ ...link(ref), key: ref.key })),
      ...body.map((ref) => ({ ...link(ref), line: ref.position.start.line + 1 })),
    ];
  }

  private async loadVault(): Promise<Vault> {
    const { vault, metadataCache } = this.app;
    const settings = this.settings;
    const ignored = (path: string) => isIgnored(path, settings);
    const files = await Promise.all(
      vault.getFiles().map(async (file): Promise<IndexedFile> => {
        const indexed: IndexedFile = { path: file.path, size: file.stat.size, mtime: file.stat.mtime };
        if (ignored(file.path)) return indexed;
        if (hasText(file.path)) indexed.text = await vault.cachedRead(file);
        if (file.extension === "md") {
          const cache = metadataCache.getFileCache(file);
          indexed.frontmatter = cache?.frontmatter ?? null;
          indexed.aliases = parseFrontMatterAliases(cache?.frontmatter ?? null) ?? [];
          indexed.links = this.linksOf(file, cache);
        }
        return indexed;
      })
    );
    return new Vault({ files, resolve: (target, source) => this.resolve(target, source) }, { typeProperty: settings.typeProperty, parseYaml, ignored });
  }

  /** The schema of the settings; when it is missing or unreadable, an empty one and the problem. */
  private async loadSchema(): Promise<Loaded> {
    const path = this.settings.schemaFile;
    const { adapter } = this.app.vault;
    const problem = (code: string, message: string, hint: string): Loaded => ({
      schema: new Schema({}, this.settings.typeProperty),
      problem: { severity: "error", code, path: path || "(no schema file)", line: 1, message, hint },
    });
    if (!path || !(await adapter.exists(path))) {
      return problem("schema-missing", "schema file not found", "create it (see the plugin's README) or set its path in the plugin's settings");
    }
    try {
      return { schema: new Schema(parseYaml(await adapter.read(path)), this.settings.typeProperty), problem: null };
    } catch (err) {
      return problem("schema-invalid", `invalid YAML: ${err instanceof Error ? err.message : err}`.replace(/\n/g, " "), "");
    }
  }

  /** The schema, or an error to show when there is none. */
  private async requireSchema(): Promise<Schema> {
    const { schema, problem } = await this.loadSchema();
    if (problem) throw new Error(`${problem.message} (${problem.path})${problem.hint ? `: ${problem.hint}` : ""}`);
    return schema;
  }

  private async check(): Promise<{ vault: Vault; schema: Schema; issues: Issue[]; hasSchema: boolean; today: string }> {
    const [vault, { schema, problem }] = await Promise.all([this.loadVault(), this.loadSchema()]);
    const today = localDate();
    const issues = lint(vault, schema, today);
    if (problem) issues.unshift(problem);
    this.calendar = calendarSpec(schema);
    return { vault, schema, issues, hasSchema: !problem, today };
  }

  private async readIfExists(path: string): Promise<string | null> {
    const { adapter } = this.app.vault;
    return path && (await adapter.exists(path)) ? adapter.read(path) : null;
  }

  /** Writes a file only when its text changes; creates the folder if missing. */
  private async writeIfChanged(path: string, text: string): Promise<boolean> {
    const { adapter } = this.app.vault;
    const folder = path.slice(0, path.lastIndexOf("/"));
    if (folder && !(await adapter.exists(folder))) await adapter.mkdir(folder);
    if ((await adapter.exists(path)) && (await adapter.read(path)) === text) return false;
    await adapter.write(path, text);
    return true;
  }

  private async appendLog(entry: string): Promise<void> {
    const path = this.settings.logFile;
    if (!path) return;
    const current = (await this.readIfExists(path)) ?? "";
    await this.writeIfChanged(path, current + entry);
  }

  private async writeBriefing(vault: Vault, schema: Schema, issues: Issue[], today: string): Promise<void> {
    if (!this.settings.briefingFile) return;
    const log = (await this.readIfExists(this.settings.logFile)) ?? "";
    await this.writeIfChanged(this.settings.briefingFile, briefing(vault, schema, issues, today, log, await this.importLines()));
  }

  private async loadRecall(vault: Vault): Promise<RecallResult[] | null> {
    const text = await this.readIfExists(this.settings.recallFile);
    return text === null ? null : runRecall(vault, parseYaml(text));
  }

  /** The status bar shows the lint; the briefing for agents stays current. */
  private async refreshState(): Promise<void> {
    const { vault, schema, issues, hasSchema, today } = await this.check();
    const counts = countBySeverity(issues);
    this.status?.setText(`Second Brain: ${plural(counts.error, "error")} · ${plural(counts.warning, "warning")}`);
    if (hasSchema) await this.writeBriefing(vault, schema, issues, today);
  }

  /** The note named by file= or path=, or the active one. */
  private noteQuery(params: CliData): string {
    const query = params.path ?? params.file ?? this.app.workspace.getActiveFile()?.path;
    if (!query || query === "true") throw new Error("name the note with file=<name> or path=<path>");
    return query;
  }

  /** Commands of Obsidian's command line: `obsidian-cli second-brain:<name> key=value`. */
  private registerCli(): void {
    if (typeof this.registerCliHandler !== "function") return; // Obsidian before 1.12.2
    const cli = (name: string, description: string, flags: CliFlags | null, handler: (params: CliData) => Promise<string>) =>
      this.registerCliHandler(`second-brain:${name}`, description, flags, async (params) => {
        try {
          return await handler(params);
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : err}`;
        }
      });

    cli(
      "lint",
      "Check the vault against its schema",
      { all: { description: "Also list the notices" }, format: { value: "text|json", description: "Output format (default: text)" } },
      async (params) => {
        const { issues } = await this.check();
        return params.format === "json" ? JSON.stringify(issues, null, 1) : lintReport(issues, params.all === "true");
      }
    );
    cli("recall", "Run the recall tests of the recall file", null, async () => {
      const results = await this.loadRecall(await this.loadVault());
      return results === null ? `No recall tests: ${this.settings.recallFile || "no file"} does not exist.` : recallReport(results);
    });
    cli(
      "links",
      "Links of a note, grouped by property, outgoing and incoming",
      { ...NOTE_FLAGS, format: { value: "text|json", description: "Output format (default: text)" } },
      async (params) => linksReport(await this.loadVault(), this.noteQuery(params), params.format === "json")
    );
    cli(
      "path",
      "Shortest path between two notes, with the name of each relation",
      {
        from: { value: "<name>", description: "First note", required: true },
        to: { value: "<name>", description: "Second note", required: true },
        all: { description: "Also through notes without a type" },
      },
      async (params) => pathReport(await this.loadVault(), params.from, params.to, params.all === "true")
    );
    cli(
      "neighbors",
      "Notes within N steps of a note",
      { ...NOTE_FLAGS, depth: { value: "<n>", description: "Steps (default: 1)" } },
      async (params) => neighboursReport(await this.loadVault(), this.noteQuery(params), Number(params.depth ?? 1))
    );
    cli("briefing", "Write the briefing (also done after every change)", null, async () => {
      if (!this.settings.briefingFile) throw new Error("no briefing file in the settings");
      await this.requireSchema();
      const { vault, schema, issues, today } = await this.check();
      await this.writeBriefing(vault, schema, issues, today);
      return `wrote ${this.settings.briefingFile}`;
    });
    cli(
      "conform",
      "Give notes the properties of their template, in order; preview unless apply",
      {
        file: { value: "<name>", description: "Only this note (default: every note)" },
        path: { value: "<path>", description: "Only the note at this path" },
        apply: { description: "Write the changes" },
      },
      (params) => this.conformCli(params)
    );
    cli("templates", "Write note templates and Obsidian property types from the schema", null, () => this.writeTemplates());
    cli(
      "health-import",
      "Read Health Auto Export's folders into the data files (desktop); preview unless apply",
      { apply: { description: "Write the data files" }, rebuild: { description: "Read every source file again, not only new or changed ones" } },
      async (params) => this.importHealth(params.apply === "true", params.rebuild === "true")
    );
  }

  private async conformCli(params: CliData): Promise<string> {
    const [vault, schema] = await Promise.all([this.loadVault(), this.requireSchema()]);
    const query = params.path ?? params.file;
    const apply = params.apply === "true";
    const notes = query ? [vault.get(query)] : vault.typedNotes();
    const lines: string[] = [];
    const changed: string[] = [];
    for (const note of notes) {
      const next = schema.conform(note.meta);
      if (!next) continue;
      const added = Object.keys(next).filter((key) => !(key in note.meta));
      lines.push(`${apply ? "+" : "?"} ${note.path}  (${added.length ? `+ ${added.join(", ")}` : "order"})`);
      if (apply) await this.conform(note, schema);
      changed.push(note.path);
    }
    const count = plural(changed.length, "note");
    lines.push("", `${count} ${apply ? "conformed to" : "to conform to"} their template.`);
    if (apply && changed.length) {
      await this.appendLog([`\n## [${localDate()}] conform | ${count} conformed to their template\n`, ...changed.map((path) => `- ${path}\n`)].join(""));
    } else if (changed.length) {
      lines.push("Preview: no file written. Run again with apply.");
    }
    return lines.join("\n");
  }

  private async writeTemplates(): Promise<string> {
    const schema = await this.requireSchema();
    const folder = this.settings.templatesFolder;
    if (!folder) throw new Error("no templates folder in the settings");
    const { adapter, configDir } = this.app.vault;
    const typesFile = `${configDir}/types.json`;
    const current = (await adapter.exists(typesFile)) ? JSON.parse(await adapter.read(typesFile)) : {};
    await this.writeIfChanged(typesFile, propertyTypes(schema, current));
    // Obsidian keeps the property types in memory: reload them, or it writes the old ones back.
    await (this.app as unknown as { metadataTypeManager?: { loadData?: () => Promise<void> } }).metadataTypeManager?.loadData?.();
    const templates = templateFiles(schema);
    for (const [name, text] of templates) await this.writeIfChanged(`${folder}/${name}.md`, text);
    return `wrote ${typesFile} and ${templates.size} templates in ${folder}/`;
  }

  private async checkVault(): Promise<void> {
    const { vault, schema, issues, hasSchema } = await this.check();
    const recall = await this.loadRecall(vault);
    const toConform = hasSchema ? vault.typedNotes().filter((note) => schema.conform(note.meta)) : [];
    new ReportModal(this.app, issues, recall, toConform.map((note) => note.path), async () => {
      for (const note of toConform) await this.conform(note, schema);
      new Notice(`Conformed ${toConform.length} note${toConform.length === 1 ? "" : "s"} to their templates.`, 5000);
    }).open();
  }

  /** A new note gets the properties and body of its template, once it has a type and while it has no text. */
  private async completeNote(file: TFile): Promise<void> {
    const text = await this.app.vault.read(file);
    if (splitFrontmatter(text).body.trim()) {
      this.fresh.delete(file.path);
      return;
    }
    const { schema, problem } = await this.loadSchema();
    if (problem || !completeNew(text, schema)) return;
    this.fresh.delete(file.path);
    await this.app.vault.process(file, (current) => completeNew(current, schema) ?? current);
  }

  private async conformActive(file: TFile): Promise<void> {
    const [vault, schema] = await Promise.all([this.loadVault(), this.requireSchema()]);
    const note = vault.notes.get(file.path);
    const changed = note ? await this.conform(note, schema) : false;
    new Notice(changed ? `"${file.basename}" now follows its template.` : `"${file.basename}" already follows its template, or has no type.`, 5000);
  }

  private async conform(note: Note, schema: Schema): Promise<boolean> {
    const file = this.app.vault.getFileByPath(note.path);
    if (!file || !schema.conform(note.meta)) return false;
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      const next = schema.conform(frontmatter);
      if (!next) return;
      for (const key of Object.keys(frontmatter)) delete frontmatter[key];
      Object.assign(frontmatter, next);
    });
    return true;
  }

  private healthReady(): boolean {
    return Platform.isDesktopApp && healthSources(this.settings.healthSources).length > 0;
  }

  /** The automatic import: writes, and says so only when it fails, once. */
  private async autoImport(): Promise<void> {
    try {
      await this.importHealth(true);
      this.importWarned = false;
    } catch (err) {
      console.error("[SecondBrain] health import", err);
      if (!this.importWarned) new Notice(`Second Brain: health import failed: ${err instanceof Error ? err.message : err}`, 10000);
      this.importWarned = true;
    }
  }

  /** Imports every source of the settings; a report of what was read and written. */
  private async importHealth(apply: boolean, rebuild = false): Promise<string> {
    if (!Platform.isDesktopApp) throw new Error("the health import works in Obsidian for desktop");
    const sources = healthSources(this.settings.healthSources);
    if (!sources.length) throw new Error("no health source in the plugin's settings");
    if (this.importing) return "a health import is already running";
    this.importing = true;
    try {
      const reports: string[] = [];
      for (const source of sources) reports.push(await this.importSource(source.folder, source.output, apply, rebuild));
      return reports.join("\n");
    } finally {
      this.importing = false;
    }
  }

  /** Files of Health Auto Export in a folder and its subfolders; iCloud placeholders of files not downloaded counted apart. */
  private async listSource(folder: string): Promise<{ files: (SourceFile & { full: string })[]; placeholders: number }> {
    // Node's modules exist only on desktop: loaded here, so the plugin still loads on mobile.
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const files: (SourceFile & { full: string })[] = [];
    let placeholders = 0;
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.name.endsWith(".icloud")) placeholders++;
        else if (entry.name.startsWith(".")) continue;
        else if (entry.isDirectory()) await walk(full);
        else if (entry.name.toLowerCase().endsWith(".json")) {
          const stat = await fs.promises.stat(full);
          files.push({ path: path.relative(folder, full).split(path.sep).join("/"), size: stat.size, mtime: Math.round(stat.mtimeMs), full });
        }
      }
    };
    await walk(folder);
    return { files, placeholders };
  }

  private async importSource(sourceFolder: string, output: string, apply: boolean, rebuild: boolean): Promise<string> {
    const os = require("os") as typeof import("os");
    const fs = require("fs") as typeof import("fs");
    const folder = expandHome(sourceFolder, os.homedir());
    if (!fs.existsSync(folder)) throw new Error(`source folder not found: ${sourceFolder}`);
    const statePath = `${output}/${FILES.state}`;
    const state = readState(await this.readIfExists(statePath));
    const { files, placeholders } = await this.listSource(folder);
    const toRead = rebuild ? [...files].sort((a, b) => a.mtime - b.mtime) : (changedFiles(files, state) as typeof files);
    const notDownloaded = placeholders ? `; ${plural(placeholders, "file")} not yet downloaded from iCloud` : "";
    if (!toRead.length) return `${output}: up to date (${plural(files.length, "source file")}${notDownloaded}).`;

    // What is already in the vault, then the new files on top.
    const read = (name: string) => this.readIfExists(`${output}/${name}`);
    const texts = { daily: await read(FILES.daily), workouts: await read(FILES.workouts), splits: await read(FILES.splits), running: await read(FILES.running) };
    const minutes = new Map<string, string | null>();
    for (const row of parseJsonl(texts.workouts ?? "")) if (typeof row.id === "string") minutes.set(minutesFile(row), await read(minutesFile(row)));
    const store = loadStore(texts, (file) => minutes.get(file) ?? null);
    const counts = newCounts();
    const unreadable: string[] = [];
    for (const file of toRead) {
      try {
        addExport(store, JSON.parse(await fs.promises.readFile(file.full, "utf8")), counts, file.path);
      } catch {
        unreadable.push(file.path);
      }
    }
    derive(store, { maxHr: this.settings.healthMaxHr, sex: this.settings.healthSex });

    const changed: string[] = [];
    for (const [name, text] of outputFiles(store)) {
      if ((await read(name)) === text) continue;
      changed.push(name);
      if (apply) await this.writeIfChanged(`${output}/${name}`, text);
    }
    const summary =
      `${output}: ${plural(counts.files, "export")} read` +
      (counts.ignored.length ? `, ${plural(counts.ignored.length, "other JSON file")} left out` : "") +
      (unreadable.length ? `, ${plural(unreadable.length, "unreadable file")} (${unreadable.slice(0, 3).join(", ")})` : "") +
      `; ${plural(counts.days.size, "day")}, ${plural(counts.workouts.size, "workout")}, ${plural(counts.running, "running sample")}` +
      `; ${plural(changed.length, "data file")} ${apply ? "written" : "to write"}${notDownloaded}.`;
    if (!apply) return [summary, ...changed.slice(0, 12).map((name) => `  ? ${output}/${name}`), changed.length > 12 ? `  … and ${changed.length - 12} more` : "", "Preview: no file written. Run again with apply."].filter(Boolean).join("\n");

    const next: ImportState = { files: { ...state.files }, last: { time: new Date().toISOString(), ok: !unreadable.length, message: summary } };
    for (const file of toRead) if (!unreadable.includes(file.path)) next.files[file.path] = { size: file.size, mtime: file.mtime };
    await this.writeIfChanged(statePath, JSON.stringify(next, null, 1) + "\n");
    return summary;
  }

  /** The last import of each health source, for the briefing. */
  private async importLines(): Promise<string[]> {
    const lines: string[] = [];
    for (const { output } of healthSources(this.settings.healthSources)) {
      const last = readState(await this.readIfExists(`${output}/${FILES.state}`)).last;
      if (last) lines.push(`Health import ${last.time.slice(0, 16).replace("T", " ")} UTC${last.ok ? "" : " (with errors)"}: ${last.message}`);
    }
    return lines;
  }

  private calendarReady(): boolean {
    return Platform.isDesktopApp && Platform.isMacOS && Boolean(this.settings.calendarSocket) && this.calendar !== null;
  }

  /** A call to the calendar helper, which holds the calendar permission. */
  private async helper<T>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
    if (!Platform.isDesktopApp || !Platform.isMacOS) throw new Error("the calendar commands work in Obsidian for Mac");
    if (!this.settings.calendarSocket) throw new Error("set the socket of the calendar helper in the plugin's settings");
    // Node's modules exist only on desktop: loaded here, so the plugin still loads on mobile.
    const net = require("net") as typeof import("net");
    const os = require("os") as typeof import("os");
    return callHelper<T>(net, expandHome(this.settings.calendarSocket, os.homedir()), tool, args);
  }

  private async calendarSetup(): Promise<{ vault: Vault; schema: Schema; spec: CalendarSpec }> {
    const [vault, schema] = await Promise.all([this.loadVault(), this.requireSchema()]);
    const spec = calendarSpec(schema);
    if (!spec) throw new Error("no type of the schema has a calendar rule (see the plugin's README)");
    return { vault, schema, spec };
  }

  /** Creates the event a note describes, or updates it when the note already links one; asks first. */
  private async addToCalendar(file: TFile): Promise<void> {
    const { vault, spec } = await this.calendarSetup();
    const note = vault.notes.get(file.path);
    if (!note || note.type !== spec.type) throw new Error(`"${file.basename}" is not a note of type ${spec.type}`);
    const draft = draftFromNote(note.name, note.meta, spec);
    const id = eventId(note.meta[spec.link]);
    let accounts: string[] = [];
    if (!id) {
      const health = await this.helper<{ accounts: { role: string; source: string | null }[] }>("health");
      accounts = health.accounts.filter((account) => account.source).map((account) => account.role);
      if (!accounts.length) throw new Error("the calendar helper finds no account: run its health check");
    }
    const url = `obsidian://open?vault=${encodeURIComponent(this.app.vault.getName())}&file=${encodeURIComponent(file.path)}`;
    new CalendarModal(this.app, draft, accounts, this.settings.calendarAccount, async (account) => {
      const event = id
        ? await this.helper<CalendarEvent>("update_event", { id, ...draft, url })
        : await this.helper<CalendarEvent>("create_event", { account, ...draft, url });
      await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
        frontmatter[spec.link] = event.link;
      });
      if (!id) {
        this.settings.calendarAccount = account;
        await this.saveData(this.settings);
      }
      new Notice(`"${event.title}" ${id ? "updated in" : "added to"} the calendar (${event.account}).`, 5000);
    }).open();
  }

  /** A note for an event of the last week or the next two; opens the note it already has. */
  private async noteFromCalendar(): Promise<void> {
    const { vault, schema, spec } = await this.calendarSetup();
    const today = localDate();
    const { events } = await this.helper<{ events: CalendarEvent[] }>("list_events", { from: addDays(today, -7), to: addDays(today, 14), limit: 500 });
    if (!events.length) throw new Error("no events from a week ago to two weeks from now");
    const now = Date.now();
    events.sort((a, b) => Math.abs(Date.parse(a.start) - now) - Math.abs(Date.parse(b.start) - now));
    new EventSuggestModal(this.app, events, (event) =>
      void this.run(async () => {
        const day = event.start.slice(0, 10);
        const existing = vault.typedNotes(spec.type).find((note) => note.meta[spec.link] === event.link && asDate(note.meta[spec.start]) === day);
        let file = existing ? this.app.vault.getFileByPath(existing.path) : null;
        if (!existing) {
          const { path, text } = noteFromEvent(event, spec, schema, peopleByEmail(vault, schema, spec));
          if (spec.folder && !this.app.vault.getAbstractFileByPath(spec.folder)) await this.app.vault.createFolder(spec.folder);
          let target = path;
          for (let n = 2; this.app.vault.getAbstractFileByPath(target); n++) target = eventPath(spec, event, n);
          file = await this.app.vault.create(target, text);
        }
        if (file) await this.app.workspace.getLeaf(false).openFile(file);
        new Notice(existing ? `The event already has a note: "${existing.name}".` : `New note for "${event.title}".`, 5000);
      })
    ).open();
  }

  /** After a rename, by any route inside Obsidian: F2, drag and drop, its command line. */
  private async updateReferences(file: TAbstractFile, oldPath: string): Promise<void> {
    const { vault } = this.app;
    const { adapter, configDir } = vault;
    const isFolder = file instanceof TFolder;
    const rewrite = async (path: string, update: (text: string) => string): Promise<boolean> => {
      if (!path || !(await adapter.exists(path))) return false;
      const text = await adapter.read(path);
      const next = update(text);
      if (next !== text) await adapter.write(path, next);
      return next !== text;
    };

    const ownSettings = renamedSettings(this.settings, oldPath, file.path);
    if (ownSettings) {
      this.settings = ownSettings;
      await this.saveData(this.settings);
    }
    let views = 0;
    for (const view of vault.getFiles().filter((f) => f.extension === "base")) {
      if (await rewrite(view.path, (text) => updateView(text, oldPath, file.path, isFolder))) views++;
    }
    let settings = false;
    if (isFolder) {
      await rewrite(this.settings.schemaFile, (text) => updateSchema(text, oldPath, file.path));
      const own = `${this.manifest.dir}/data.json`;
      const plugins = (await adapter.list(`${configDir}/plugins`)).folders.map((folder) => `${folder}/data.json`).filter((path) => path !== own);
      for (const path of [`${configDir}/app.json`, `${configDir}/templates.json`, ...plugins]) {
        if (await rewrite(path, (text) => updateSettings(text, oldPath, file.path))) settings = true;
      }
    }
    if (settings) new Notice("Folder renamed: settings updated. Reload Obsidian to apply them.", 10000);
    else if (views || ownSettings) new Notice(`References updated after renaming "${file.name}".`, 5000);
  }
}

class SecondBrainSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: SecondBrainPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const settings = this.plugin.settings;
    containerEl.empty();
    const text = (name: string, description: string, key: Exclude<keyof Settings, "ignoredFolders" | "completeNewNotes" | "healthSources" | "healthMaxHr" | "healthSex" | "healthEvery">) =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(description)
        .addText((input) =>
          input
            .setPlaceholder(DEFAULT_SETTINGS[key] || "(none)")
            .setValue(settings[key])
            .onChange(async (value) => {
              settings[key] = value.trim();
              await this.plugin.saveSettings();
            })
        );

    text("Schema file", "YAML file with the types of notes, their properties and the rules of the checks. Its format is in the plugin's README.", "schemaFile");
    text("Type property", "The property that holds the type of a note.", "typeProperty");
    new Setting(containerEl)
      .setName("Ignored folders")
      .setDesc("Folders left out of checks, links and counts, one per line. The templates folder and the briefing are always left out.")
      .addTextArea((input) =>
        input
          .setPlaceholder("Archive\nAttachments/Old")
          .setValue(settings.ignoredFolders.join("\n"))
          .onChange(async (value) => {
            settings.ignoredFolders = folderList(value);
            await this.plugin.saveSettings();
          })
      );
    text("Templates folder", "Where the templates command writes a template for each type.", "templatesFolder");
    new Setting(containerEl)
      .setName("Complete new notes")
      .setDesc("A note created in Obsidian gets the properties and the body of its type's template as soon as it has a type, while it has no text. Turn it off if another plugin applies templates.")
      .addToggle((toggle) =>
        toggle.setValue(settings.completeNewNotes).onChange(async (value) => {
          settings.completeNewNotes = value;
          await this.plugin.saveSettings();
        })
      );
    text("Briefing file", "A page of starting context for agents, rewritten after every change. Leave empty for none.", "briefingFile");
    text("Log file", "Where the conform command records the notes it changed; its latest entries go in the briefing.", "logFile");
    text("Recall tests file", "Questions with a known answer, solved through the links.", "recallFile");
    text(
      "Calendar helper socket",
      "Unix socket of the local calendar helper, for the calendar commands (Obsidian for Mac). Empty: no calendar commands.",
      "calendarSocket"
    );

    new Setting(containerEl).setName("Health import").setHeading();
    new Setting(containerEl)
      .setName("Sources")
      .setDesc("Obsidian for desktop. One per line: a folder of Health Auto Export's JSON exports, an arrow, the vault folder for its data. ~ is the home folder.")
      .addTextArea((input) =>
        input
          .setPlaceholder("~/Library/Mobile Documents/iCloud~com~ifunography~HealthExport/Documents -> Data/Health/Jane Doe")
          .setValue(settings.healthSources.join("\n"))
          .onChange(async (value) => {
            settings.healthSources = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
            await this.plugin.saveSettings();
          })
      );
    const number = (name: string, description: string, key: "healthMaxHr" | "healthEvery") =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(description)
        .addText((input) =>
          input.setValue(String(settings[key])).onChange(async (value) => {
            const n = Number(value);
            if (!Number.isFinite(n) || n < 0) return;
            settings[key] = n;
            await this.plugin.saveSettings();
          })
        );
    number("Maximum heart rate", "For the heart-rate zones and the training load. 0: the highest seen in a workout.", "healthMaxHr");
    new Setting(containerEl)
      .setName("Sex")
      .setDesc("For the weighting of the training load (Banister's TRIMP).")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("male", "Male")
          .addOption("female", "Female")
          .setValue(settings.healthSex)
          .onChange(async (value) => {
            settings.healthSex = value === "female" ? "female" : "male";
            await this.plugin.saveSettings();
          })
      );
    number("Import every (minutes)", "0: only by command. Takes effect at the next start of Obsidian.", "healthEvery");
  }
}

/** When an event happens, in a line. */
function when(start: string, end: string | undefined, allDay: boolean): string {
  if (allDay) return end && end !== start ? `${start} → ${end}, whole days` : `${start}, whole day`;
  const from = start.slice(0, 16).replace("T", " ");
  if (!end) return `${from}, one hour`;
  return end.slice(0, 10) === start.slice(0, 10) ? `${from}–${end.slice(11, 16)}` : `${from} → ${end.slice(0, 16).replace("T", " ")}`;
}

/** Shows the event before it is written; the account only for a new event. */
class CalendarModal extends Modal {
  private account: string;

  constructor(app: App, private draft: Draft, private accounts: string[], preferred: string, private onConfirm: (account: string) => Promise<void>) {
    super(app);
    this.account = accounts.includes(preferred) ? preferred : accounts[0] ?? "";
  }

  onOpen(): void {
    const { contentEl, draft } = this;
    const update = !this.accounts.length;
    this.titleEl.setText(update ? "Update the event in the calendar" : "Add the event to the calendar");
    new Setting(contentEl).setName(draft.title).setDesc(when(draft.start, draft.end, draft.all_day));
    if (draft.location) new Setting(contentEl).setName("Location").setDesc(draft.location);
    if (!update) {
      new Setting(contentEl)
        .setName("Calendar")
        .setDesc("No one is invited. To invite people, open the event in the calendar app and add them there.")
        .addDropdown((dropdown) => {
          for (const account of this.accounts) dropdown.addOption(account, account);
          dropdown.setValue(this.account).onChange((value) => (this.account = value));
        });
    }
    new Setting(contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((button) =>
        button
          .setButtonText(update ? "Update" : "Add")
          .setCta()
          .onClick(async () => {
            button.setDisabled(true);
            try {
              await this.onConfirm(this.account);
              this.close();
            } catch (err) {
              new Notice(`Second Brain: ${err instanceof Error ? err.message : err}`, 8000);
              button.setDisabled(false);
            }
          })
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** The events of the calendar, nearest first; typing filters them. */
class EventSuggestModal extends SuggestModal<CalendarEvent> {
  constructor(app: App, private events: CalendarEvent[], private onChoose: (event: CalendarEvent) => void) {
    super(app);
    this.setPlaceholder("An event of the last week or the next two");
  }

  getSuggestions(query: string): CalendarEvent[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return this.events.filter((event) => {
      const text = `${event.title} ${event.location ?? ""} ${event.account} ${event.start.slice(0, 10)}`.toLowerCase();
      return words.every((word) => text.includes(word));
    });
  }

  renderSuggestion(event: CalendarEvent, el: HTMLElement): void {
    el.createEl("div", { text: event.title });
    el.createEl("small", { text: [when(event.start, event.end, event.all_day), event.account, event.location].filter(Boolean).join(" · ") });
  }

  onChooseSuggestion(event: CalendarEvent): void {
    this.onChoose(event);
  }
}
