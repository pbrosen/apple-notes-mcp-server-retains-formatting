import { describe, it, expect } from "vitest";
import { checkedItemTexts } from "../src/writer/archive.js";
import type { Note } from "../src/types.js";

const note: Note = {
  title: "T",
  sections: [
    { header: "A", items: [
      { text: "a1", checked: false },
      { text: "a2", checked: true },
    ]},
    { header: "B", items: [
      { text: "b1", checked: true },
      { text: "b2", checked: false },
    ]},
  ],
};

describe("checkedItemTexts", () => {
  it("returns all checked item texts across sections, in top-to-bottom order", () => {
    expect(checkedItemTexts(note)).toEqual(["a2", "b1"]);
  });
  it("returns [] when nothing is checked", () => {
    expect(checkedItemTexts({ title: "T", sections: [{ header: "A", items: [{ text: "x", checked: false }] }] })).toEqual([]);
  });
});
