import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { PermissionError } from "../errors.js";

const LIVE_DB = join(
  homedir(),
  "Library/Group Containers/group.com.apple.notes/NoteStore.sqlite",
);

/**
 * Copy the live NoteStore.sqlite to a fresh temp file via `sqlite3 .backup`.
 * This produces a consistent snapshot (WAL included), never locks or writes the live file,
 * and requires only read access. Caller is responsible for deleting the returned file's dir.
 */
export function snapshotDb(): string {
  if (!existsSync(LIVE_DB)) {
    throw new PermissionError(
      `NoteStore.sqlite not found at ${LIVE_DB}. Is Notes.app set up on this account, ` +
        `and does the app running this server have Full Disk Access?`,
    );
  }
  const dir = mkdtempSync(join(tmpdir(), "notes-snap-"));
  const dest = join(dir, "snap.sqlite");
  try {
    execFileSync("sqlite3", [`file:${LIVE_DB}?mode=ro`, `.backup '${dest}'`], {
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    const msg = String(err?.stderr ?? err?.message ?? e);
    if (/authorization denied|unable to open|operation not permitted/i.test(msg)) {
      throw new PermissionError(
        "Cannot read NoteStore.sqlite: Full Disk Access is not granted.\n" +
          "Grant it in System Settings → Privacy & Security → Full Disk Access " +
          "(enable the app running this server, e.g. Conductor or your terminal), then retry.",
      );
    }
    throw e;
  }
  return dest;
}
