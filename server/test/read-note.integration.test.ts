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

  it("reads the note title", () => {
    expect(note.title).toBe("MCP Scratch List");
  });

  it("returns well-formed sections and items (invariants, not exact content)", () => {
    expect(note.sections.length).toBeGreaterThan(0);
    for (const s of note.sections) {
      expect(s.header === null || typeof s.header === "string").toBe(true);
      for (const i of s.items) {
        expect(typeof i.text).toBe("string");
        expect(i.text.length).toBeGreaterThan(0);
        expect(typeof i.checked).toBe("boolean");
      }
    }
  });

  it("recovers checked state as booleans (at least one item exists)", () => {
    const items = note.sections.flatMap((s) => s.items);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => typeof i.checked === "boolean")).toBe(true);
  });
});
