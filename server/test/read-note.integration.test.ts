import { describe, it, expect } from "vitest";
import { readNote } from "../src/reader/reader.js";

// Integration test: exercises the full live pipeline (snapshot + sqlite + gunzip + protobuf
// + grouping) against the real "MCP Scratch List" note. Requires Full Disk Access.
//
// Exact-content correctness is locked by proto-parse.test.ts against a frozen blob; this note
// is also the Writer's mutation target, so here we assert only STABLE invariants that survive
// item-level edits rather than brittle exact content.
describe("readNote (integration, live DB)", () => {
  const note = readNote("MCP Scratch List");
  const KNOWN_HEADERS = ["Personal", "High Priority", "Today", "Normal Priority", "Low Priority", "Done"];

  it("reads the note title", () => {
    expect(note.title).toBe("MCP Scratch List");
  });

  it("returns well-formed sections and items", () => {
    expect(note.sections.length).toBeGreaterThan(0);
    for (const s of note.sections) {
      expect(KNOWN_HEADERS).toContain(s.header);
      for (const i of s.items) {
        expect(typeof i.text).toBe("string");
        expect(i.text.length).toBeGreaterThan(0);
        expect(typeof i.checked).toBe("boolean");
      }
    }
  });

  it("recovers real checked state (the Done section's items are all checked)", () => {
    const done = note.sections.find((s) => s.header === "Done");
    expect(done).toBeTruthy();
    expect(done!.items.length).toBeGreaterThan(0);
    expect(done!.items.every((i) => i.checked)).toBe(true);
  });
});
