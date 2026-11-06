// The Second Brain plugin: checks the vault and keeps it consistent, inside
// Obsidian, on any device. Commands in the palette and in Obsidian's command line
// (`obsidian-cli second-brain:…`); lint and briefing redone after every change.
// The logic is in src/, tested with Node.

import { debounce, Notice, parseYaml, Plugin, TAbstractFile, TFile, TFolder, type CliData, type CliFlags } from "obsidian";
import { briefing } from "./src/briefing";
import { lintReport, linksReport, neighboursReport, pathReport, recallReport } from "./src/commands";
import { BRIEFING_FILE, GENERATED, LOG_FILE, RECALL_FILE, SCHEMA_FILE, TEMPLATES_FOLDER } from "./src/paths";
import { countBySeverity, type Issue, lint } from "./src/lint";
import { runRecall } from "./src/recall";
import { updateSchema, updateSettings, updateView } from "./src/references";
import { ReportModal } from "./src/ReportModal";
import { Schema } from "./src/schema";
import { propertyTypes, templateFiles } from "./src/templates";
import { localDate } from "./src/text";
import { hasText, isVaultFile, type Note, Vault } from "./src/vault";


const NOTE_FLAGS: CliFlags = {
  file: { value: "<name>", description: "Note name or alias (default: the active note)" },
  path: { value: "<path>", description: "Note path" },
};

export default class SecondBrainPlugin extends Plugin {
  /** Renames run one at a time: moving a folder fires one event for each file inside. */
  private renames: Promise<void> = Promise.resolve();
  private status?: HTMLElement;
  /** Lint and briefing again, a few seconds after the last change. */
  private refresh = debounce(() => void this.run(() => this.refreshState()), 3000, true);

  onload(): void {
    this.status = this.addStatusBarItem();
    this.status.addClass("mod-clickable");
    this.status.setAttr("aria-label", "Check the vault");
    this.status.onClickEvent(() => void this.run(() => this.checkVault()));
    this.registerCli();
    this.app.workspace.onLayoutReady(() => {
      this.refresh();
      const changed = (file: TAbstractFile) => {
        if (!file.path.startsWith(GENERATED)) this.refresh();
      };
      this.registerEvent(this.app.vault.on("create", changed));
      this.registerEvent(this.app.vault.on("modify", changed));
      this.registerEvent(this.app.vault.on("delete", changed));
      this.registerEvent(this.app.vault.on("rename", changed));
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

  private async run(task: () => Promise<void>): Promise<void> {
    try {
      await task();
    } catch (err) {
      new Notice(`Second Brain: ${err instanceof Error ? err.message : err}`, 8000);
      console.error("[SecondBrain]", err);
    }
  }

  private async loadVault(): Promise<Vault> {
    const entries = this.app.vault.getFiles().filter((file) => isVaultFile(file.path));
    return new Vault(
      await Promise.all(
        entries.map(async (file) => ({
          path: file.path,
          size: file.stat.size,
          mtime: file.stat.mtime,
          text: hasText(file.path) ? await this.app.vault.cachedRead(file) : undefined,
        }))
      ),
      parseYaml
    );
  }

  private async loadSchema(): Promise<Schema> {
    return new Schema(parseYaml(await this.app.vault.adapter.read(SCHEMA_FILE)));
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

  private async writeBriefing(vault: Vault, schema: Schema, issues: Issue[], today: string): Promise<void> {
    await this.writeIfChanged(BRIEFING_FILE, briefing(vault, schema, issues, today));
  }

  /** The status bar shows the lint; the briefing for agents stays current. */
  private async refreshState(): Promise<void> {
    const [vault, schema] = await Promise.all([this.loadVault(), this.loadSchema()]);
    const today = localDate();
    const issues = lint(vault, schema, today);
    const counts = countBySeverity(issues);
    this.status?.setText(`Second Brain: ${counts.error} errori · ${counts.warning} avvisi`);
    await this.writeBriefing(vault, schema, issues, today);
  }

  /** The note named by file= or path=, or the active one. */
  private noteQuery(params: CliData): string {
    const query = params.path ?? params.file ?? this.app.workspace.getActiveFile()?.path;
    if (!query || query === "true") throw new Error("indica la nota con file=<nome> o path=<percorso>");
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
          return `Errore: ${err instanceof Error ? err.message : err}`;
        }
      });

    cli(
      "lint",
      "Check the vault against its schema",
      { all: { description: "Also list the notices" }, format: { value: "text|json", description: "Output format (default: text)" } },
      async (params) => {
        const [vault, schema] = await Promise.all([this.loadVault(), this.loadSchema()]);
        const issues = lint(vault, schema, localDate());
        return params.format === "json" ? JSON.stringify(issues, null, 1) : lintReport(issues, params.all === "true");
      }
    );
    cli("recall", "Run the recall tests of system/tests/recall.yaml", null, async () => {
      const vault = await this.loadVault();
      return recallReport(runRecall(vault, parseYaml(await this.app.vault.adapter.read(RECALL_FILE))));
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
    cli("briefing", `Write ${BRIEFING_FILE} (also done after every change)`, null, async () => {
      const [vault, schema] = await Promise.all([this.loadVault(), this.loadSchema()]);
      const today = localDate();
      await this.writeBriefing(vault, schema, lint(vault, schema, today), today);
      return `scritto ${BRIEFING_FILE}`;
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
    const [vault, schema] = await Promise.all([this.loadVault(), this.loadSchema()]);
    const query = params.path ?? params.file;
    const apply = params.apply === "true";
    const notes = query ? [vault.get(query)] : vault.typedNotes();
    const lines: string[] = [];
    const changed: string[] = [];
    for (const note of notes) {
      const next = schema.conform(note.meta);
      if (!next) continue;
      const added = Object.keys(next).filter((key) => !(key in note.meta));
      lines.push(`${apply ? "+" : "?"} ${note.path}  (${added.length ? `+ ${added.join(", ")}` : "ordine"})`);
      if (apply) await this.conform(note, schema);
      changed.push(note.path);
    }
    lines.push("", `${changed.length} note ${apply ? "completate" : "da completare"} con il loro template.`);
    if (apply && changed.length) {
      const entry = [`\n## [${localDate()}] conform | ${changed.length} note completate con il loro template\n`, ...changed.map((path) => `- ${path}\n`)];
      await this.app.vault.adapter.append(LOG_FILE, entry.join(""));
    } else if (changed.length) {
      lines.push("Anteprima: nessun file scritto. Ripeti con apply.");
    }
    return lines.join("\n");
  }

  private async writeTemplates(): Promise<string> {
    const schema = await this.loadSchema();
    const { adapter, configDir } = this.app.vault;
    const typesFile = `${configDir}/types.json`;
    const current = (await adapter.exists(typesFile)) ? JSON.parse(await adapter.read(typesFile)) : {};
    await this.writeIfChanged(typesFile, propertyTypes(schema, current));
    // Obsidian keeps the property types in memory: reload them, or it writes the old ones back.
    await (this.app as unknown as { metadataTypeManager?: { loadData?: () => Promise<void> } }).metadataTypeManager?.loadData?.();
    const templates = templateFiles(schema);
    for (const [name, text] of templates) await this.writeIfChanged(`${TEMPLATES_FOLDER}/${name}.md`, text);
    return `scritti ${typesFile} e ${templates.size} template in ${TEMPLATES_FOLDER}/`;
  }

  private async checkVault(): Promise<void> {
    const [vault, schema] = await Promise.all([this.loadVault(), this.loadSchema()]);
    const recall = runRecall(vault, parseYaml(await this.app.vault.adapter.read(RECALL_FILE)));
    const toConform = vault.typedNotes().filter((note) => schema.conform(note.meta));
    new ReportModal(this.app, lint(vault, schema, localDate()), recall, toConform.map((note) => note.path), async () => {
      for (const note of toConform) await this.conform(note, schema);
      new Notice(`Conformed ${toConform.length} note${toConform.length === 1 ? "" : "s"} to their templates.`, 5000);
    }).open();
  }

  private async conformActive(file: TFile): Promise<void> {
    const [vault, schema] = await Promise.all([this.loadVault(), this.loadSchema()]);
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
      if (!(await adapter.exists(path))) return false;
      const text = await adapter.read(path);
      const next = update(text);
      if (next !== text) await adapter.write(path, next);
      return next !== text;
    };

    let views = 0;
    for (const view of vault.getFiles().filter((f) => f.extension === "base")) {
      if (await rewrite(view.path, (text) => updateView(text, oldPath, file.path, isFolder))) views++;
    }
    let settings = false;
    if (isFolder) {
      await rewrite(SCHEMA_FILE, (text) => updateSchema(text, oldPath, file.path));
      const plugins = (await adapter.list(`${configDir}/plugins`)).folders.map((folder) => `${folder}/data.json`);
      for (const path of [`${configDir}/app.json`, `${configDir}/templates.json`, ...plugins]) {
        if (await rewrite(path, (text) => updateSettings(text, oldPath, file.path))) settings = true;
      }
    }
    if (settings) new Notice("Folder renamed: settings updated. Reload Obsidian to apply them.", 10000);
    else if (views) new Notice(`Views updated after renaming "${file.name}".`, 5000);
  }
}
