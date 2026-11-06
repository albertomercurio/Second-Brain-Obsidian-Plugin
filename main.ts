// The Second Brain plugin: checks the vault against its schema and keeps it
// consistent, inside Obsidian, on any device. Commands in the palette and in
// Obsidian's command line (`obsidian-cli second-brain:…`); lint and briefing
// redone after every change. The logic is in src/, which knows nothing of
// Obsidian: this file gives it the vault as Obsidian indexes it.

import {
  App,
  type CachedMetadata,
  type CliData,
  type CliFlags,
  debounce,
  getLinkpath,
  Notice,
  parseFrontMatterAliases,
  parseYaml,
  Plugin,
  PluginSettingTab,
  type Reference,
  Setting,
  TAbstractFile,
  TFile,
  TFolder,
} from "obsidian";
import { briefing } from "./src/briefing";
import { lintReport, linksReport, neighboursReport, pathReport, plural, recallReport } from "./src/commands";
import { countBySeverity, type Issue, lint } from "./src/lint";
import { type RecallResult, runRecall } from "./src/recall";
import { updateSchema, updateSettings, updateView } from "./src/references";
import { ReportModal } from "./src/ReportModal";
import { Schema } from "./src/schema";
import { DEFAULT_SETTINGS, folderList, isIgnored, readSettings, renamedSettings, type Settings } from "./src/settings";
import { propertyTypes, templateFiles } from "./src/templates";
import { localDate } from "./src/text";
import { hasText, type IndexedFile, type IndexedLink, type Note, Vault } from "./src/vault";

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
    await this.writeIfChanged(this.settings.briefingFile, briefing(vault, schema, issues, today, log));
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
    const text = (name: string, description: string, key: Exclude<keyof Settings, "ignoredFolders">) =>
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
    text("Briefing file", "A page of starting context for agents, rewritten after every change. Leave empty for none.", "briefingFile");
    text("Log file", "Where the conform command records the notes it changed; its latest entries go in the briefing.", "logFile");
    text("Recall tests file", "Questions with a known answer, solved through the links.", "recallFile");
  }
}
