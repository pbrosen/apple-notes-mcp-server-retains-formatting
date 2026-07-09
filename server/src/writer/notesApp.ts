import { execFileSync } from "node:child_process";
import { PermissionError, StructureError } from "../errors.js";
import { sleepSync } from "../util.js";

/** Bring Notes to the front and show the note titled `title` (so the helper edits the right note). */
export function openNote(title: string): void {
  const script =
    `tell application "Notes"\n` +
    `  activate\n` +
    `  set matches to (every note whose name is ${JSON.stringify(title)})\n` +
    `  if (count of matches) is 0 then error "note-not-found"\n` +
    `  show item 1 of matches\n` +
    `end tell`;
  try {
    execFileSync("osascript", ["-e", script], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (e) {
    const msg = String((e as { stderr?: string; message?: string }).stderr ?? (e as Error).message ?? e);
    if (/-1743|not authorized|assistive|automation/i.test(msg)) {
      throw new PermissionError(
        "Automation permission to control Notes is not granted. Approve the 'control Notes' " +
          "prompt (System Settings → Privacy & Security → Automation), then retry.",
      );
    }
    throw new StructureError(`Could not open note "${title}" in Notes: ${msg}`);
  }
  sleepSync(400); // let the front window switch to the target note
}

/** Create a new note whose title (first line) is `title`. Created in the default folder/account. */
export function createNote(title: string): void {
  const script =
    `tell application "Notes"\n` +
    `  make new note with properties {body:${JSON.stringify(title)}}\n` +
    `end tell`;
  try {
    execFileSync("osascript", ["-e", script], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (e) {
    const msg = String((e as { stderr?: string; message?: string }).stderr ?? (e as Error).message ?? e);
    if (/-1743|not authorized|assistive|automation/i.test(msg)) {
      throw new PermissionError(
        "Automation permission to control Notes is not granted. Approve the 'control Notes' prompt, then retry.",
      );
    }
    throw new StructureError(`Could not create note "${title}" in Notes: ${msg}`);
  }
}
