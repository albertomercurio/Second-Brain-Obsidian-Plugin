import { App, Modal, Setting } from "obsidian";
import type { Issue } from "./lint";
import type { RecallResult } from "./recall";

/** Results of the vault check: problems linked to their notes, the recall tests, the notes to conform. */
export class ReportModal extends Modal {
  constructor(
    app: App,
    private issues: Issue[],
    /** Null when the vault has no recall tests. */
    private recall: RecallResult[] | null,
    private toConform: string[],
    private conform: () => Promise<void>
  ) {
    super(app);
  }

  private noteLink(parent: HTMLElement, path: string): void {
    if (!this.app.vault.getAbstractFileByPath(path)) {
      parent.appendText(path);
      return;
    }
    const link = parent.createEl("a", { text: path, href: "#" });
    link.addEventListener("click", (event) => {
      event.preventDefault();
      this.close();
      void this.app.workspace.openLinkText(path, "", false);
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    this.setTitle("Vault check");
    const shown = this.issues.filter((issue) => issue.severity !== "info");
    const notices = this.issues.length - shown.length;
    contentEl.createEl("p", { text: `${shown.length} problems, ${notices} notices.` });
    const list = contentEl.createEl("ul");
    for (const issue of shown) {
      const item = list.createEl("li");
      item.createEl("strong", { text: `${issue.severity} ` });
      this.noteLink(item, issue.path);
      item.appendText(`: ${issue.message}`);
      if (issue.hint) item.createEl("div", { text: `→ ${issue.hint}` });
    }

    if (this.recall) {
      const failed = this.recall.filter((result) => !result.ok);
      contentEl.createEl("h3", { text: "Recall tests" });
      contentEl.createEl("p", { text: `${this.recall.length - failed.length}/${this.recall.length} passed.` });
      const failures = contentEl.createEl("ul");
      for (const result of failed) failures.createEl("li", { text: `${result.id}: ${result.question} → ${result.got.join(", ") || "no answer"}` });
    }

    if (!this.toConform.length) return;
    contentEl.createEl("h3", { text: "Notes that differ from their template" });
    contentEl.createEl("p", { text: "Missing properties are added empty and the order is restored. Values and text do not change." });
    const notes = contentEl.createEl("ul");
    for (const path of this.toConform) this.noteLink(notes.createEl("li"), path);
    new Setting(contentEl).addButton((button) =>
      button
        .setCta()
        .setButtonText(`Conform ${this.toConform.length} note${this.toConform.length === 1 ? "" : "s"}`)
        .onClick(() => {
          this.close();
          void this.conform();
        })
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
