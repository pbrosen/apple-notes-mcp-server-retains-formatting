import { describe, it, expect } from "vitest";
import { resolveNote } from "../src/reader/resolve.js";
import { NoteNotFoundError, AmbiguousNoteError } from "../src/errors.js";
import type { NoteRow } from "../src/types.js";

const row = (pk: number, title: string, folder: string, modified: number): NoteRow =>
  ({ pk, title, folder, account: "iCloud", modified, dataPk: pk + 100 });

describe("resolveNote", () => {
  it("returns the single match", () => {
    expect(resolveNote([row(1, "Groceries", "Notes", 10)], "Groceries").pk).toBe(1);
  });

  it("throws NoteNotFoundError when nothing matches", () => {
    expect(() => resolveNote([], "Groceries")).toThrow(NoteNotFoundError);
  });

  it("throws AmbiguousNoteError listing candidates when >1 matches", () => {
    const rows = [row(1, "Groceries", "Home", 10), row(2, "Groceries", "Work", 20)];
    try {
      resolveNote(rows, "Groceries");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AmbiguousNoteError);
      expect((e as Error).message).toContain("Home");
      expect((e as Error).message).toContain("Work");
    }
  });
});
