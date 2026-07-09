# Apple Notes Checklist MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a stdio MCP server that reads Apple Notes checklist state (headers + item text + true checked-state) directly from `NoteStore.sqlite`, and mutates notes (append unchecked items, check/uncheck, move checked items between sections) through the macOS Accessibility API via System Events.

**Architecture:** Two subsystems in one Node/TypeScript process. **Reader** = snapshot `NoteStore.sqlite` (read-only) → gunzip the `ZDATA` protobuf blob → parse with `protobufjs` → structured JSON. **Writer** = spawn `osascript` System Events scripts that walk the Accessibility tree by role + text (no pixel coordinates) to insert/toggle/move checklist rows. Every mutation is verified by re-reading via the Reader.

**Tech Stack:** TypeScript, Node 22, `@modelcontextprotocol/sdk`, `better-sqlite3`, `protobufjs`, Node `zlib`, `vitest`; the system `sqlite3` CLI for snapshots; `osascript`/System Events for writes; Swift 6.3 (only if Phase 2 is escalated).

**Machine facts (already verified):** macOS 26.5.1 (build 25F80), Notes.app 4.13, Full Disk Access confirmed working for Conductor.app, `sqlite3` 3.51.0, Node 22.18.0, Swift 6.3.

**Documented protobuf schema defaults** (from `github.com/threeplanetssoftware/apple_cloud_notes_parser`; Phase 0 verifies these on-device before the parser trusts them):
- `NoteStoreProto.document` = field 2 → `Document.note` = field 3 → `Note.note_text` = field 2 (string), `Note.attribute_run` = field 5 (repeated).
- `AttributeRun.length` = field 1, `AttributeRun.paragraph_style` = field 2.
- `ParagraphStyle.style_type` = field 1, `ParagraphStyle.checklist` = field 5.
- `Checklist.uuid` = field 1 (bytes), `Checklist.done` = field 2 (int; `1` = checked).
- `style_type` enum: `title=0`, `heading=1`, `subheading=2`, `monospaced=4`, `bullet(dotted)=100`, `dashed=101`, `numbered=102`, `checkbox/checklist=103`. A paragraph is a checklist row when `style_type == 103` and a `checklist` submessage is present; it is checked when `checklist.done == 1`.
- `note_text` uses `\n` (U+000A) as the paragraph separator.

---

## File Structure

```
server/
  src/
    index.ts        # MCP server entrypoint, tool registration, verify-after-write
    reader/
      snapshot.ts   # snapshotDb(): copy live DB to a temp dir via `sqlite3 .backup`
      db.ts         # findNoteRows(): query snapshot for note rows by title; getNoteData()
      resolve.ts    # resolveNote(candidates, title): pure disambiguation logic
      proto.ts      # parseNoteProto(gunzippedBuffer): protobuf -> paragraphs[]
      paragraphs.ts # paragraphsToSections(paragraphs): pure grouping into {title, sections}
      reader.ts     # readNote(title): orchestrates snapshot -> query -> gunzip -> parse -> group
      types.ts      # Note, Section, Item, Paragraph, NoteRow interfaces
    writer/
      osascript.ts  # runOsascript(): spawn osascript with a JS payload, JSON in/out
      writer.ts     # append(), setChecked(), moveChecked() -> build & run AX scripts
      scripts/      # .applescript / .js templates for the System Events AX operations
    errors.ts       # typed errors: PermissionError, NoteNotFoundError, AmbiguousNoteError, StructureError, VerifyError
    notes.proto     # trimmed protobuf schema
  test/
    fixtures/       # captured real note blob(s) + expected parsed output
    *.test.ts
  package.json
  tsconfig.json
  vitest.config.ts
helper/             # Swift AX helper — ONLY created if Phase 2 is escalated (Task 15)
README.md
docs/
  phase0-findings.md  # produced by Phase 0 tasks
```

Everything lives at the **repo root** (this repo *is* the project — no extra wrapper folder).

---

## Phase 0 — Probe this machine

These tasks discover ground truth before any parser code is written. They produce `docs/phase0-findings.md` and `server/test/fixtures/`. Do not start Phase 1 until Tasks 1–3 are complete and the findings doc records the confirmed field numbers, enum values, and AX roles.

### Task 1: Probe SQLite schema and locate a checklist note

**Files:**
- Create: `docs/phase0-findings.md`
- Create: `server/test/fixtures/.gitkeep`

- [ ] **Step 1: Create a throwaway scratch checklist note in Notes.app (manual, do this yourself)**

Open Notes.app and create a note titled exactly `MCP Scratch List` with this content (use Format → Checklist for the checklist lines; use Format → Heading for the headers):

```
MCP Scratch List
Personal
[ ] buy milk
[x] pick up dry cleaning
Work
[ ] email Dana
```

Where `[ ]` = unchecked checklist row, `[x]` = checked checklist row. `Personal` and `Work` are Heading-styled lines. Leave Notes open with this note visible.

- [ ] **Step 2: Dump the schema of the tables of interest**

Run:
```bash
TMPD=$(mktemp -d); SRC="$HOME/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite"
sqlite3 "file:$SRC?mode=ro" ".backup '$TMPD/snap.sqlite'"
sqlite3 "$TMPD/snap.sqlite" ".schema ZICCLOUDSYNCINGOBJECT" | head -80
echo "=== ZICNOTEDATA ==="; sqlite3 "$TMPD/snap.sqlite" ".schema ZICNOTEDATA"
echo "=== tables ==="; sqlite3 "$TMPD/snap.sqlite" "SELECT name FROM sqlite_master WHERE type='table' ORDER BY 1;"
echo "$TMPD" > /tmp/mcp_snap_dir
```
Expected: real column names. Record in findings: the exact columns for **title** (likely `ZTITLE1`), **modification date** (likely `ZMODIFICATIONDATE1`), **folder** foreign key (likely `ZFOLDER`), **account** (likely `ZACCOUNT*`), the note↔data linkage (likely `ZICNOTEDATA.ZNOTE` → `ZICCLOUDSYNCINGOBJECT.Z_PK`), the **data blob** column (likely `ZICNOTEDATA.ZDATA`), and any "recently deleted"/trashed marker (e.g. `ZMARKEDFORDELETION`, or folder name `Recently Deleted`).

- [ ] **Step 3: Find the scratch note's row and its data pk**

Run (adjust column names to whatever Step 2 revealed):
```bash
TMPD=$(cat /tmp/mcp_snap_dir)
sqlite3 "$TMPD/snap.sqlite" "SELECT Z_PK, ZTITLE1 FROM ZICCLOUDSYNCINGOBJECT WHERE ZTITLE1='MCP Scratch List';"
sqlite3 "$TMPD/snap.sqlite" "SELECT Z_PK, ZNOTE, length(ZDATA) FROM ZICNOTEDATA WHERE ZNOTE IN (SELECT Z_PK FROM ZICCLOUDSYNCINGOBJECT WHERE ZTITLE1='MCP Scratch List');"
```
Expected: one note row and one data row with a non-zero `ZDATA` length. Record both pks in findings.

- [ ] **Step 4: Record findings**

Write `docs/phase0-findings.md` with a "SQLite schema" section: confirmed column names for title/mod-date/folder/account, the note→data join, the blob column, and the trashed marker. Note any deviation from the documented defaults above.

- [ ] **Step 5: Commit**

```bash
git add docs/phase0-findings.md server/test/fixtures/.gitkeep
git commit -m "phase0: confirm NoteStore.sqlite schema and locate scratch note"
```

### Task 2: Decode the ZDATA blob and capture a fixture

**Files:**
- Modify: `docs/phase0-findings.md`
- Create: `server/test/fixtures/scratch-list.bin` (gunzipped protobuf bytes)

- [ ] **Step 1: Extract and gunzip the scratch note's ZDATA to a file**

Run (uses the snapshot from Task 1; adjust the WHERE join to confirmed column names):
```bash
TMPD=$(cat /tmp/mcp_snap_dir)
sqlite3 "$TMPD/snap.sqlite" \
  "SELECT writefile('/tmp/zdata.gz', ZDATA) FROM ZICNOTEDATA WHERE ZNOTE IN (SELECT Z_PK FROM ZICCLOUDSYNCINGOBJECT WHERE ZTITLE1='MCP Scratch List');"
# ZDATA is gzip; gunzip to the fixture path
gunzip -c /tmp/zdata.gz > server/test/fixtures/scratch-list.bin 2>/tmp/gz_err || (echo "not gzip? try raw:"; cat /tmp/gz_err)
ls -l server/test/fixtures/scratch-list.bin
```
Expected: a decompressed protobuf file of a few hundred bytes. If `gunzip` errors with "not in gzip format", record that in findings and instead decompress with Node zlib inflate in Step 2's fallback.

- [ ] **Step 2: Raw-decode the protobuf to confirm field numbers and enums**

Run:
```bash
which protoc >/dev/null 2>&1 && protoc --decode_raw < server/test/fixtures/scratch-list.bin | head -120 \
  || node -e 'const b=require("fs").readFileSync("server/test/fixtures/scratch-list.bin");let i=0;while(i<b.length&&i<400){const t=b[i++];const f=t>>3,w=t&7;let v;if(w===0){v=0n;let s=0n;while(b[i]&0x80){v|=BigInt(b[i++]&0x7f)<<s;s+=7n;}v|=BigInt(b[i++]&0x7f)<<s;}else if(w===2){let len=0,s=0;while(b[i]&0x80){len|=(b[i++]&0x7f)<<s;s+=7;}len|=(b[i++]&0x7f)<<s;v="len="+len;i+=len;}else{v="wire"+w;}console.log("field",f,"wire",w,String(v));}'
```
Expected: you should see field 2 (the `document` submessage) at top level; drilling in, the `note_text` string containing "buy milk"/"pick up dry cleaning"/etc., and repeated `attribute_run` entries. **Confirm:** the `style_type` values actually emitted for the Heading lines and checklist lines, and the `done` field on the checked row. Record the observed numbers in findings — these override the documented defaults if different.

- [ ] **Step 3: Record the confirmed protobuf layout in findings**

Add a "Protobuf layout (confirmed)" section to `docs/phase0-findings.md`: the confirmed field numbers for `note_text`, `attribute_run`, `paragraph_style`, `style_type`, `checklist`, `done`; the confirmed `style_type` value for checklist rows and for headings; and where `done` lives (inline vs embedded). Note the compression format actually used (gzip vs raw deflate).

- [ ] **Step 4: Commit**

```bash
git add server/test/fixtures/scratch-list.bin docs/phase0-findings.md
git commit -m "phase0: capture decoded note blob fixture and confirm protobuf layout"
```

### Task 3: Probe the Notes Accessibility tree

**Files:**
- Modify: `docs/phase0-findings.md`

- [ ] **Step 1: Grant Accessibility to Conductor (manual)**

System Settings → Privacy & Security → Accessibility → add/enable **Conductor**. (Needed for System Events UI scripting.)

- [ ] **Step 2: Dump the AX tree of the open scratch note**

With Notes open and `MCP Scratch List` visible, run:
```bash
osascript -e 'tell application "System Events" to tell process "Notes"
  set out to ""
  try
    set out to entire contents of front window
  end try
  return out
end tell' 2>&1 | tr "," "\n" | head -200
```
Expected: a flat list of UI elements. The first run may trigger a one-time "Conductor wants to control System Events" prompt — approve it. If output is empty or an error, record the exact error in findings.

- [ ] **Step 3: Inspect roles for checklist rows and the editor**

Run a more targeted probe to see element roles/values in the note body:
```bash
osascript -e 'tell application "System Events" to tell process "Notes"
  set res to {}
  set uiEls to entire contents of front window
  repeat with e in uiEls
    try
      set r to role of e
      set d to ""
      try
        set d to value of e as string
      end try
      if r is in {"AXCheckBox", "AXStaticText", "AXTextArea", "AXGroup"} then
        set end of res to (r & " :: " & d)
      end if
    end try
  end repeat
  return res
end tell' 2>&1 | tr "," "\n" | head -120
```
Expected: reveals whether checklist rows are individual `AXCheckBox`/`AXStaticText` elements (System Events can target them) OR whether the whole body is a single `AXTextArea` with rows as internal text (would require the Swift range API). Record which.

- [ ] **Step 4: Record AX findings and the escalation decision**

Add an "Accessibility tree" section to findings: the role of the note editor; whether checklist rows/checkboxes are addressable elements or internal ranges; the role used for Heading lines; and a one-line decision: **"Proceed with System Events (Phase 2)"** or **"Escalate to Swift helper (Phase 3) because rows are not individually addressable."** All later Writer tasks follow this decision.

- [ ] **Step 5: Commit**

```bash
git add docs/phase0-findings.md
git commit -m "phase0: probe Notes accessibility tree and record writer approach decision"
```

---

## Phase 1 — Reader

### Task 4: Scaffold the TypeScript project

**Files:**
- Create: `server/package.json`, `server/tsconfig.json`, `server/vitest.config.ts`, `server/src/types.ts`

- [ ] **Step 1: Create `server/package.json`**

```json
{
  "name": "apple-notes-checklist-mcp",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": { "apple-notes-checklist-mcp": "dist/index.js" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "dev": "tsx src/index.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "better-sqlite3": "^11.0.0",
    "protobufjs": "^7.4.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^22.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.6.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create `server/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create `server/vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
```

- [ ] **Step 4: Create `server/src/types.ts`**

```typescript
export type StyleType =
  | "title" | "heading" | "subheading" | "checklist" | "body" | "other";

export interface Paragraph {
  text: string;
  style: StyleType;
  checked: boolean; // meaningful only when style === "checklist"
}

export interface Item {
  text: string;
  checked: boolean;
}

export interface Section {
  header: string | null; // null = leading section before any heading
  items: Item[];
}

export interface Note {
  title: string;
  sections: Section[];
}

export interface NoteRow {
  pk: number;
  title: string;
  folder: string | null;
  account: string | null;
  modified: number | null; // Core Data timestamp
  dataPk: number;
}
```

- [ ] **Step 5: Install and verify the toolchain**

Run:
```bash
cd server && npm install && npx tsc --noEmit && echo "SCAFFOLD_OK"
```
Expected: install succeeds (better-sqlite3 compiles or fetches a prebuild), `tsc --noEmit` passes, prints `SCAFFOLD_OK`.

- [ ] **Step 6: Commit**

```bash
git add server/package.json server/tsconfig.json server/vitest.config.ts server/src/types.ts
git commit -m "reader: scaffold TypeScript MCP server project"
```

### Task 5: Trimmed protobuf schema + loader

**Files:**
- Create: `server/src/notes.proto`
- Create: `server/src/reader/proto.ts`
- Create: `server/test/proto-load.test.ts`

> Adjust field numbers/enum values in this task to whatever Task 2 confirmed if they differ from the documented defaults.

- [ ] **Step 1: Write the failing test `server/test/proto-load.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { loadNoteStoreType } from "../src/reader/proto.js";

describe("proto loader", () => {
  it("loads the NoteStoreProto message type", () => {
    const t = loadNoteStoreType();
    expect(t).toBeTruthy();
    expect(typeof t.decode).toBe("function");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && npx vitest run test/proto-load.test.ts`
Expected: FAIL — cannot find `../src/reader/proto.js`.

- [ ] **Step 3: Write `server/src/notes.proto`**

```proto
syntax = "proto2";

message NoteStoreProto { optional Document document = 2; }
message Document { optional int32 version = 2; optional Note note = 3; }

message Note {
  optional string note_text = 2;
  repeated AttributeRun attribute_run = 5;
}

message AttributeRun {
  optional int32 length = 1;
  optional ParagraphStyle paragraph_style = 2;
}

message ParagraphStyle {
  optional int32 style_type = 1;
  optional Checklist checklist = 5;
}

message Checklist {
  optional bytes uuid = 1;
  optional int32 done = 2;
}
```

- [ ] **Step 4: Write `server/src/reader/proto.ts`**

```typescript
import protobuf from "protobufjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Paragraph, StyleType } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// style_type enum -> our StyleType (Task 2 confirms these numbers on-device)
const STYLE_MAP: Record<number, StyleType> = {
  0: "title", 1: "heading", 2: "subheading", 103: "checklist",
};
export const CHECKLIST_STYLE = 103;

let cached: protobuf.Type | null = null;
export function loadNoteStoreType(): protobuf.Type {
  if (cached) return cached;
  const root = protobuf.loadSync(join(__dirname, "..", "notes.proto"));
  cached = root.lookupType("NoteStoreProto");
  return cached;
}

export function styleFromType(n: number | undefined): StyleType {
  if (n === undefined) return "body";
  return STYLE_MAP[n] ?? "other";
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd server && npx vitest run test/proto-load.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/notes.proto server/src/reader/proto.ts server/test/proto-load.test.ts
git commit -m "reader: add trimmed notes.proto schema and loader"
```

### Task 6: Parse the note blob into paragraphs

**Files:**
- Create: `server/src/reader/proto.ts` (extend with `parseNoteProto`)
- Create: `server/test/proto-parse.test.ts`

- [ ] **Step 1: Write the failing test `server/test/proto-parse.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseNoteProto } from "../src/reader/proto.js";

const blob = readFileSync(join(__dirname, "fixtures", "scratch-list.bin"));

describe("parseNoteProto", () => {
  const paras = parseNoteProto(blob);

  it("recovers every visible line as a paragraph", () => {
    const texts = paras.map((p) => p.text);
    expect(texts).toContain("buy milk");
    expect(texts).toContain("pick up dry cleaning");
    expect(texts).toContain("email Dana");
    expect(texts).toContain("Personal");
    expect(texts).toContain("Work");
  });

  it("marks Heading lines as headings", () => {
    expect(paras.find((p) => p.text === "Personal")!.style).toBe("heading");
    expect(paras.find((p) => p.text === "Work")!.style).toBe("heading");
  });

  it("marks checklist rows and their checked state", () => {
    const milk = paras.find((p) => p.text === "buy milk")!;
    const dry = paras.find((p) => p.text === "pick up dry cleaning")!;
    expect(milk.style).toBe("checklist");
    expect(milk.checked).toBe(false);
    expect(dry.style).toBe("checklist");
    expect(dry.checked).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && npx vitest run test/proto-parse.test.ts`
Expected: FAIL — `parseNoteProto` is not exported.

- [ ] **Step 3: Add `parseNoteProto` to `server/src/reader/proto.ts`**

```typescript
import type { Paragraph } from "../types.js";
import { CHECKLIST_STYLE } from "./proto.js"; // (already in this file; shown for clarity)

export function parseNoteProto(gunzipped: Uint8Array): Paragraph[] {
  const NoteStore = loadNoteStoreType();
  const msg: any = NoteStore.decode(gunzipped);
  const note = msg?.document?.note;
  if (!note) return [];
  const text: string = note.note_text ?? "";
  const runs: any[] = note.attribute_run ?? [];

  // Map each character offset to the paragraph_style of the run covering it.
  const charStyleType: (number | undefined)[] = new Array(text.length);
  const charDone: (boolean)[] = new Array(text.length).fill(false);
  let offset = 0;
  for (const run of runs) {
    const len: number = run.length ?? 0;
    const ps = run.paragraph_style;
    const st: number | undefined = ps?.style_type;
    const done = ps?.checklist?.done === 1;
    for (let k = 0; k < len && offset < text.length; k++, offset++) {
      charStyleType[offset] = st;
      charDone[offset] = done;
    }
  }

  // Split note_text into paragraphs on "\n"; take style from the paragraph's first char.
  const paras: Paragraph[] = [];
  let start = 0;
  const pushPara = (from: number, to: number) => {
    const raw = text.slice(from, to);
    const st = styleFromType(charStyleType[from]);
    const checked = charStyleType[from] === CHECKLIST_STYLE && charDone[from];
    paras.push({ text: raw, style: st, checked });
  };
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") { pushPara(start, i); start = i + 1; }
  }
  if (start < text.length) pushPara(start, text.length);
  return paras;
}
```
(Remove the redundant self-import line; `CHECKLIST_STYLE` and `styleFromType` are already in this module.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx vitest run test/proto-parse.test.ts`
Expected: PASS. If a `style_type`/`done` assertion fails, correct `STYLE_MAP`/`CHECKLIST_STYLE`/`done` handling to match Task 2's confirmed numbers, then re-run.

- [ ] **Step 5: Commit**

```bash
git add server/src/reader/proto.ts server/test/proto-parse.test.ts
git commit -m "reader: parse note blob into styled paragraphs (TDD against real fixture)"
```

### Task 7: Group paragraphs into sections

**Files:**
- Create: `server/src/reader/paragraphs.ts`
- Create: `server/test/paragraphs.test.ts`

- [ ] **Step 1: Write the failing test `server/test/paragraphs.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { paragraphsToNote } from "../src/reader/paragraphs.js";
import type { Paragraph } from "../src/types.js";

const paras: Paragraph[] = [
  { text: "MCP Scratch List", style: "title", checked: false },
  { text: "loose item", style: "checklist", checked: false },
  { text: "Personal", style: "heading", checked: false },
  { text: "buy milk", style: "checklist", checked: false },
  { text: "pick up dry cleaning", style: "checklist", checked: true },
  { text: "just a note", style: "body", checked: false },
  { text: "Work", style: "heading", checked: false },
  { text: "email Dana", style: "checklist", checked: false },
];

describe("paragraphsToNote", () => {
  const note = paragraphsToNote(paras);

  it("takes the title from the title paragraph", () => {
    expect(note.title).toBe("MCP Scratch List");
  });

  it("puts pre-heading checklist items in a null-header section", () => {
    expect(note.sections[0].header).toBeNull();
    expect(note.sections[0].items).toEqual([{ text: "loose item", checked: false }]);
  });

  it("groups checklist items under their heading, ignoring non-checklist body", () => {
    const personal = note.sections.find((s) => s.header === "Personal")!;
    expect(personal.items).toEqual([
      { text: "buy milk", checked: false },
      { text: "pick up dry cleaning", checked: true },
    ]);
    const work = note.sections.find((s) => s.header === "Work")!;
    expect(work.items).toEqual([{ text: "email Dana", checked: false }]);
  });

  it("omits sections that have no checklist items", () => {
    // a heading with only body text under it should not appear
    const only = paragraphsToNote([
      { text: "T", style: "title", checked: false },
      { text: "Empty", style: "heading", checked: false },
      { text: "prose", style: "body", checked: false },
    ]);
    expect(only.sections).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && npx vitest run test/paragraphs.test.ts`
Expected: FAIL — `paragraphsToNote` not found.

- [ ] **Step 3: Write `server/src/reader/paragraphs.ts`**

```typescript
import type { Paragraph, Note, Section } from "../types.js";

const HEADINGS = new Set(["title", "heading", "subheading"]);

export function paragraphsToNote(paras: Paragraph[]): Note {
  let title = "";
  const sections: Section[] = [];
  let current: Section = { header: null, items: [] };

  for (const p of paras) {
    if (p.style === "title" && title === "") { title = p.text; continue; }
    if (p.style === "heading" || p.style === "subheading") {
      if (current.items.length > 0) sections.push(current);
      current = { header: p.text, items: [] };
      continue;
    }
    if (p.style === "checklist") {
      current.items.push({ text: p.text, checked: p.checked });
    }
    // non-checklist body paragraphs are intentionally omitted from output
  }
  if (current.items.length > 0) sections.push(current);
  return { title, sections };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx vitest run test/paragraphs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/reader/paragraphs.ts server/test/paragraphs.test.ts
git commit -m "reader: group styled paragraphs into title + checklist sections"
```

### Task 8: Note disambiguation logic

**Files:**
- Create: `server/src/reader/resolve.ts`
- Create: `server/src/errors.ts`
- Create: `server/test/resolve.test.ts`

- [ ] **Step 1: Write `server/src/errors.ts`**

```typescript
export class PermissionError extends Error {}
export class NoteNotFoundError extends Error {}
export class AmbiguousNoteError extends Error {}
export class StructureError extends Error {}
export class VerifyError extends Error {}
```

- [ ] **Step 2: Write the failing test `server/test/resolve.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { resolveNote } from "../src/reader/resolve.js";
import { NoteNotFoundError, AmbiguousNoteError } from "../src/errors.js";
import type { NoteRow } from "../src/types.js";

const row = (pk: number, title: string, folder: string, modified: number): NoteRow =>
  ({ pk, title, folder, account: "iCloud", modified, dataPk: pk + 100 });

describe("resolveNote", () => {
  it("returns the single match", () => {
    const r = resolveNote([row(1, "Groceries", "Notes", 10)], "Groceries");
    expect(r.pk).toBe(1);
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
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd server && npx vitest run test/resolve.test.ts`
Expected: FAIL — `resolveNote` not found.

- [ ] **Step 4: Write `server/src/reader/resolve.ts`**

```typescript
import type { NoteRow } from "../types.js";
import { NoteNotFoundError, AmbiguousNoteError } from "../errors.js";

export function resolveNote(candidates: NoteRow[], title: string): NoteRow {
  const matches = candidates.filter((c) => c.title === title);
  if (matches.length === 0) {
    throw new NoteNotFoundError(`No note titled "${title}" found (excluding Recently Deleted).`);
  }
  if (matches.length > 1) {
    const lines = matches
      .map((m) => `  - folder="${m.folder ?? "?"}" account="${m.account ?? "?"}" modified=${m.modified ?? "?"}`)
      .join("\n");
    throw new AmbiguousNoteError(
      `Multiple notes titled "${title}" found; refusing to guess:\n${lines}\nRename one so the title is unique.`,
    );
  }
  return matches[0];
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd server && npx vitest run test/resolve.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/errors.ts server/src/reader/resolve.ts server/test/resolve.test.ts
git commit -m "reader: add note disambiguation logic and typed errors"
```

### Task 9: Snapshot + DB query modules

**Files:**
- Create: `server/src/reader/snapshot.ts`
- Create: `server/src/reader/db.ts`

> Uses the confirmed column names from Task 1. Replace the `COL_*` constants below with the real names recorded in `docs/phase0-findings.md`.

- [ ] **Step 1: Write `server/src/reader/snapshot.ts`**

```typescript
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { PermissionError } from "../errors.js";

const LIVE_DB = join(
  homedir(),
  "Library/Group Containers/group.com.apple.notes/NoteStore.sqlite",
);

/** Copy the live DB to a fresh temp file via `sqlite3 .backup` (consistent, WAL-safe, read-only). */
export function snapshotDb(): string {
  if (!existsSync(LIVE_DB)) {
    throw new PermissionError(
      `NoteStore.sqlite not found at ${LIVE_DB}. Is Notes.app set up on this account?`,
    );
  }
  const dir = mkdtempSync(join(tmpdir(), "notes-snap-"));
  const dest = join(dir, "snap.sqlite");
  try {
    execFileSync("sqlite3", [`file:${LIVE_DB}?mode=ro`, `.backup '${dest}'`], {
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (e: any) {
    const msg = String(e?.stderr ?? e?.message ?? e);
    if (/authorization denied|unable to open/i.test(msg)) {
      throw new PermissionError(
        "Cannot read NoteStore.sqlite: Full Disk Access is not granted.\n" +
          "Grant it in System Settings → Privacy & Security → Full Disk Access " +
          "(enable the app running this server, e.g. Conductor/Terminal), then retry.",
      );
    }
    throw e;
  }
  return dest;
}
```

- [ ] **Step 2: Write `server/src/reader/db.ts`**

```typescript
import Database from "better-sqlite3";
import { gunzipSync, inflateSync } from "node:zlib";
import type { NoteRow } from "../types.js";

// === Column names confirmed in Task 1 (docs/phase0-findings.md). Update if different. ===
const T_OBJ = "ZICCLOUDSYNCINGOBJECT";
const T_DATA = "ZICNOTEDATA";
const COL_TITLE = "ZTITLE1";
const COL_MODIFIED = "ZMODIFICATIONDATE1";
const COL_FOLDER_FK = "ZFOLDER";
const COL_DATA_NOTE_FK = "ZNOTE";
const COL_DATA_BLOB = "ZDATA";
const RECENTLY_DELETED = "Recently Deleted";

/** Query the snapshot for all non-deleted note rows matching `title`. */
export function findNoteRows(snapshotPath: string, title: string): NoteRow[] {
  const db = new Database(snapshotPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT o.Z_PK as pk, o.${COL_TITLE} as title, o.${COL_MODIFIED} as modified,
                f.${COL_TITLE} as folder, d.Z_PK as dataPk
         FROM ${T_OBJ} o
         JOIN ${T_DATA} d ON d.${COL_DATA_NOTE_FK} = o.Z_PK
         LEFT JOIN ${T_OBJ} f ON o.${COL_FOLDER_FK} = f.Z_PK
         WHERE o.${COL_TITLE} = ?`,
      )
      .all(title) as any[];
    return rows
      .filter((r) => r.folder !== RECENTLY_DELETED)
      .map((r) => ({
        pk: r.pk, title: r.title, folder: r.folder ?? null,
        account: null, modified: r.modified ?? null, dataPk: r.dataPk,
      }));
  } finally {
    db.close();
  }
}

/** Fetch and decompress the ZDATA blob for a data-row pk. */
export function getNoteData(snapshotPath: string, dataPk: number): Uint8Array {
  const db = new Database(snapshotPath, { readonly: true });
  try {
    const row = db
      .prepare(`SELECT ${COL_DATA_BLOB} as blob FROM ${T_DATA} WHERE Z_PK = ?`)
      .get(dataPk) as { blob: Buffer } | undefined;
    if (!row?.blob) return new Uint8Array();
    return decompress(row.blob);
  } finally {
    db.close();
  }
}

function decompress(buf: Buffer): Uint8Array {
  // gzip has magic 0x1f 0x8b; otherwise assume raw/zlib deflate (per Task 2 finding).
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) return gunzipSync(buf);
  return inflateSync(buf);
}
```

- [ ] **Step 3: Type-check**

Run: `cd server && npx tsc --noEmit && echo TYPECHECK_OK`
Expected: `TYPECHECK_OK`.

- [ ] **Step 4: Commit**

```bash
git add server/src/reader/snapshot.ts server/src/reader/db.ts
git commit -m "reader: add DB snapshot + note-row query + blob decompression"
```

### Task 10: readNote orchestration + integration test

**Files:**
- Create: `server/src/reader/reader.ts`
- Create: `server/test/read-note.integration.test.ts`

- [ ] **Step 1: Write `server/src/reader/reader.ts`**

```typescript
import { rmSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { snapshotDb } from "./snapshot.js";
import { findNoteRows, getNoteData } from "./db.js";
import { resolveNote } from "./resolve.js";
import { parseNoteProto } from "./proto.js";
import { paragraphsToNote } from "./paragraphs.js";
import type { Note } from "../types.js";

export function readNote(title: string): Note {
  const snap = snapshotDb();
  try {
    const rows = findNoteRows(snap, title);
    const row = resolveNote(rows, title);
    const blob = getNoteData(snap, row.dataPk);
    const paras = parseNoteProto(blob);
    const note = paragraphsToNote(paras);
    if (!note.title) note.title = row.title; // fall back to DB title
    return note;
  } finally {
    if (existsSync(snap)) rmSync(dirname(snap), { recursive: true, force: true });
  }
}
```

- [ ] **Step 2: Write the integration test `server/test/read-note.integration.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { readNote } from "../src/reader/reader.js";

// Requires the live "MCP Scratch List" note from Phase 0 and Full Disk Access.
describe("readNote (integration, live DB)", () => {
  it("reads the scratch list with correct checked state", () => {
    const note = readNote("MCP Scratch List");
    expect(note.title).toBe("MCP Scratch List");
    const personal = note.sections.find((s) => s.header === "Personal")!;
    expect(personal.items).toContainEqual({ text: "buy milk", checked: false });
    expect(personal.items).toContainEqual({ text: "pick up dry cleaning", checked: true });
    const work = note.sections.find((s) => s.header === "Work")!;
    expect(work.items).toContainEqual({ text: "email Dana", checked: false });
  });
});
```

- [ ] **Step 3: Run the integration test**

Run: `cd server && npx vitest run test/read-note.integration.test.ts`
Expected: PASS. This is the **Phase 1 acceptance**: `read_note` output matches the on-screen scratch note including checked state. If it fails, compare against `docs/phase0-findings.md` and fix the parser/column names.

- [ ] **Step 4: Run the whole suite**

Run: `cd server && npx vitest run`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/reader/reader.ts server/test/read-note.integration.test.ts
git commit -m "reader: wire full readNote pipeline + live integration test (Phase 1 acceptance)"
```

---

## Phase 2 — Writer (System Events)

> If Task 3's decision was "Escalate to Swift", skip to the Phase 3 appendix instead, then return to Phase 4. All Writer functions expose the same signatures regardless of implementation.

### Task 11: osascript runner + AX `read` cross-check

**Files:**
- Create: `server/src/writer/osascript.ts`
- Create: `server/src/writer/scripts/read.applescript`
- Create: `server/src/writer/writer.ts`

- [ ] **Step 1: Write `server/src/writer/osascript.ts`**

```typescript
import { execFileSync } from "node:child_process";
import { PermissionError, StructureError } from "../errors.js";

/** Run an AppleScript source string, passing args, returning stdout text. */
export function runOsascript(source: string, args: string[] = []): string {
  try {
    return execFileSync("osascript", ["-e", source, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (e: any) {
    const msg = String(e?.stderr ?? e?.message ?? e);
    if (/not allowed assistive access|accessibility/i.test(msg)) {
      throw new PermissionError(
        "Accessibility permission not granted.\n" +
          "Grant it in System Settings → Privacy & Security → Accessibility " +
          "(enable the app running this server, e.g. Conductor), then retry.",
      );
    }
    if (/-1743|not authorized to send Apple events/i.test(msg)) {
      throw new PermissionError(
        "Automation permission not granted for System Events. Approve the prompt " +
          "(System Settings → Privacy & Security → Automation) and retry.",
      );
    }
    throw new StructureError(`osascript failed: ${msg}`);
  }
}
```

- [ ] **Step 2: Write `server/src/writer/writer.ts` with `openNote` + `axRead`**

> The exact AX navigation depends on Task 3's findings. This uses the "rows are addressable `AXCheckBox`/`AXStaticText`" model. If Task 3 found a single `AXTextArea`, this task escalates to Phase 3.

```typescript
import { runOsascript } from "./osascript.js";
import { StructureError } from "../errors.js";
import type { Note } from "../types.js";

/** Bring Notes to front and open the note whose title matches, via AppleScript. */
export function openNote(title: string): void {
  const src = `
    tell application "Notes"
      activate
      set matches to (every note whose name is "${esc(title)}")
      if (count of matches) is 0 then error "note-not-found"
      show item 1 of matches
    end tell
    delay 0.3`;
  runOsascript(src);
}

/** Read the live note structure from the AX tree (cross-check against the Reader). */
export function axRead(title: string): Note {
  openNote(title);
  // Implementation: walk `entire contents of front window` collecting role+value,
  // reconstruct sections/items using the roles confirmed in Task 3.
  // Returns the same {title, sections} shape.
  throw new StructureError("axRead not yet implemented — fill from Task 3 AX roles");
}

export function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
```

- [ ] **Step 3: Implement `axRead` against the confirmed roles**

Replace the `axRead` body with a script that walks `entire contents of front window`, and for each element reads `role` and `value`; treat `AXCheckBox` (or the confirmed checklist role) as items whose `value`/`AXValue` gives checked state, and the confirmed heading role as section boundaries. Parse the returned rows into `{title, sections}`. Use the concrete role names recorded in `docs/phase0-findings.md`. (No fixed code here because the roles are device-confirmed; the structure mirrors `paragraphsToNote`.)

- [ ] **Step 4: Manual cross-check**

Run a small script:
```bash
cd server && npx tsx -e 'import {axRead} from "./src/writer/writer.js"; console.log(JSON.stringify(axRead("MCP Scratch List"),null,2));'
```
Expected: same sections/checked-state as `readNote("MCP Scratch List")`. Compare the two outputs; they must agree.

- [ ] **Step 5: Commit**

```bash
git add server/src/writer/osascript.ts server/src/writer/writer.ts server/src/writer/scripts/read.applescript
git commit -m "writer: osascript runner + AX read cross-check"
```

### Task 12: append operation

**Files:**
- Modify: `server/src/writer/writer.ts`

- [ ] **Step 1: Add `append` to `writer.ts`**

```typescript
/**
 * Append UNCHECKED checklist rows to the end of `section`.
 * Positions via AX (end of the section's last checklist row), inserts via synthetic keys.
 */
export function append(title: string, section: string, items: string[]): void {
  if (items.length === 0) return;
  openNote(title);
  // 1. Locate the header element matching `section`. If not found -> StructureError.
  // 2. Find the last checklist row before the next header.
  // 3. Set the AX selection to the end of that row's text (AXSelectedTextRange),
  //    NOT a mouse click.
  // 4. For each item: System Events `key code 36` (Return), then `keystroke <text>`.
  // The new row inherits the checklist paragraph style automatically.
  const src = buildAppendScript(title, section, items);
  runOsascript(src);
}
```

- [ ] **Step 2: Implement `buildAppendScript`**

Write `buildAppendScript(title, section, items)` returning AppleScript that: selects the note (via `openNote` already done), walks `entire contents` to find the header element by text `section` (abort with `error "section-not-found"` if absent), locates the last checklist row under it, sets focus/selection to end of that row, then for each item posts `key code 36` and `keystroke "<escaped item>"`. Escape each item with `esc()`. Concrete role names from Task 3.

- [ ] **Step 3: Test against the scratch note (manual)**

Run:
```bash
cd server && npx tsx -e 'import {append} from "./src/writer/writer.js"; append("MCP Scratch List","Personal",["walk the dog"]);'
cd server && npx vitest run test/read-note.integration.test.ts 2>/dev/null; \
  npx tsx -e 'import {readNote} from "./src/reader/reader.js"; console.log(JSON.stringify(readNote("MCP Scratch List").sections.find(s=>s.header==="Personal"),null,2));'
```
Expected: "walk the dog" appears as an **unchecked** item at the end of the Personal section; Work section and the title are untouched.

- [ ] **Step 4: Test the safety rail**

Run:
```bash
cd server && npx tsx -e 'import {append} from "./src/writer/writer.js"; try{append("MCP Scratch List","Nonexistent",["x"])}catch(e){console.log("ABORTED:",e.message)}'
```
Expected: prints `ABORTED:` with a section-not-found message; the note is unchanged.

- [ ] **Step 5: Commit**

```bash
git add server/src/writer/writer.ts
git commit -m "writer: append unchecked checklist items to a section (AX-positioned)"
```

### Task 13: set_checked operation

**Files:**
- Modify: `server/src/writer/writer.ts`

- [ ] **Step 1: Add `setChecked` to `writer.ts`**

```typescript
/** Set the checked state of the row whose text matches `itemText` (exact, else unique substring). */
export function setChecked(title: string, itemText: string, checked: boolean): void {
  openNote(title);
  // 1. Walk AX tree; find the checklist row whose text == itemText (exact),
  //    else the unique row containing itemText. 0 matches or >1 ambiguous -> StructureError.
  // 2. Read the checkbox element's AXValue (0/1).
  // 3. If current != desired: perform AXPress (or set AXValue). Never blind-toggle.
  // 4. Re-read AXValue; if still != desired -> VerifyError.
  const src = buildSetCheckedScript(title, itemText, checked);
  runOsascript(src);
}
```

- [ ] **Step 2: Implement `buildSetCheckedScript`**

Write `buildSetCheckedScript(title, itemText, checked)`: AppleScript that finds the row by text (exact match first, then unique substring; abort `error "item-not-found"` / `error "item-ambiguous"`), reads the checkbox value, and only if it differs performs the toggle (`perform action "AXPress"` on the checkbox element, or set its `value`), then re-reads and `error "verify-failed"` if it didn't take. Escape `itemText` with `esc()`.

- [ ] **Step 3: Test check then uncheck (manual)**

Run:
```bash
cd server && npx tsx -e 'import {setChecked} from "./src/writer/writer.js"; setChecked("MCP Scratch List","buy milk",true);' \
  && npx tsx -e 'import {readNote} from "./src/reader/reader.js"; const p=readNote("MCP Scratch List").sections.find(s=>s.header==="Personal"); console.log(p.items);'
```
Expected: `buy milk` now `checked: true`; `pick up dry cleaning` still `true`; `email Dana` still `false`. Then run again with `false` and confirm it flips back and no other row changed.

- [ ] **Step 4: Test idempotency**

Run the `true` call twice in a row; expected: second call is a no-op (state already matches), no error, no duplicate toggling.

- [ ] **Step 5: Commit**

```bash
git add server/src/writer/writer.ts
git commit -m "writer: set_checked with read-before-write and post-toggle verify"
```

### Task 14: move_checked operation

**Files:**
- Modify: `server/src/writer/writer.ts`

- [ ] **Step 1: Add `moveChecked` to `writer.ts`**

```typescript
/** Move every checked row under any of `fromSections` to the end of `toSection`, preserving checked state. */
export function moveChecked(title: string, fromSections: string[], toSection: string): void {
  openNote(title);
  // 1. Read live structure; collect checked rows under fromSections (top-to-bottom).
  // 2. Validate toSection exists; abort if not.
  // 3. For each checked row (process bottom-up to keep indices stable):
  //    select the full line, Cmd+X, move insertion point to end of toSection, paste.
  //    Never disturb unchecked siblings.
  const src = buildMoveScript(title, fromSections, toSection);
  runOsascript(src);
}
```

- [ ] **Step 2: Implement `buildMoveScript`**

Write `buildMoveScript(title, fromSections, toSection)`: verify `toSection` exists (`error "section-not-found"` otherwise); enumerate checked rows under `fromSections`; for each (bottom-up), select the whole line (`AXSelectedTextRange` spanning the row incl. trailing newline), `keystroke "x" using command down`, set insertion point to end of `toSection`'s last row, `keystroke "v" using command down`. Escape all interpolated strings.

- [ ] **Step 3: Test the move (manual)**

Setup a `Done` heading in the scratch note first (add via `append` a dummy then convert, or add `Done` heading manually). Then:
```bash
cd server && npx tsx -e 'import {moveChecked} from "./src/writer/writer.js"; moveChecked("MCP Scratch List",["Personal","Work"],"Done");' \
  && npx tsx -e 'import {readNote} from "./src/reader/reader.js"; console.log(JSON.stringify(readNote("MCP Scratch List"),null,2));'
```
Expected: all previously-checked rows now live under `Done` **still checked**; every unchecked row stayed exactly where it was, in order.

- [ ] **Step 4: Commit**

```bash
git add server/src/writer/writer.ts
git commit -m "writer: move_checked relocates checked rows without disturbing siblings"
```

---

## Phase 3 — Swift AX helper (ONLY if Task 3 escalated)

### Task 15: Swift helper (conditional)

**Files:**
- Create: `helper/Package.swift`, `helper/Sources/notes-ax-helper/main.swift`
- Modify: `server/src/writer/writer.ts` (spawn the compiled binary instead of osascript)

- [ ] **Step 1: `helper/Package.swift`**

```swift
// swift-tools-version:6.0
import PackageDescription
let package = Package(
  name: "notes-ax-helper",
  targets: [.executableTarget(name: "notes-ax-helper")]
)
```

- [ ] **Step 2: Implement `main.swift`**

Implement a CLI that reads a JSON command from stdin (`{op:"read"|"append"|"set_checked"|"move_checked", ...}`) and writes JSON to stdout, using `AXUIElementCreateApplication` for the Notes pid, `AXUIElementCopyAttributeValue`/`AXUIElementSetAttributeValue` (incl. `kAXSelectedTextRangeAttribute`), and `AXUIElementPerformAction(kAXPressAction)`. Mirror the exact operation semantics and safety rails from Tasks 11–14. Use the AX roles confirmed in Task 3.

- [ ] **Step 3: Build and stabilize TCC identity**

```bash
cd helper && swift build -c release
codesign --force --sign - --identifier com.local.notes-ax-helper .build/release/notes-ax-helper
```
Then grant this binary Accessibility once (System Settings → Privacy & Security → Accessibility → add `.build/release/notes-ax-helper`). Ad-hoc signing with a fixed `--identifier` keeps the TCC grant stable across rebuilds.

- [ ] **Step 4: Repoint `writer.ts`**

Change the `runOsascript(...)` calls to a `runHelper(jsonCommand)` that spawns the compiled binary with JSON stdin/stdout. Keep the exported `append`/`setChecked`/`moveChecked`/`axRead` signatures identical so Phase 4 is unaffected.

- [ ] **Step 5: Re-run Tasks 12–14 manual tests against the Swift helper**

Expected: identical behavior, faster/more reliable.

- [ ] **Step 6: Commit**

```bash
git add helper server/src/writer/writer.ts
git commit -m "writer: compiled Swift AX helper (escalated from System Events)"
```

---

## Phase 4 — Wire into the MCP server

### Task 16: MCP server + read_note tool

**Files:**
- Create: `server/src/index.ts`

- [ ] **Step 1: Write `server/src/index.ts` with server bootstrap + `read_note`**

```typescript
#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readNote } from "./reader/reader.js";
import { append, setChecked, moveChecked } from "./writer/writer.js";

const server = new Server(
  { name: "apple-notes-checklist-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

const TOOLS = [
  {
    name: "read_note",
    description: "Read a Notes.app note's full structure (headers + checklist items + checked state).",
    inputSchema: { type: "object", properties: { noteTitle: { type: "string" } }, required: ["noteTitle"] },
  },
  {
    name: "append_checklist_items",
    description: "Append one or more new UNCHECKED checklist items to the end of a named section. Never touches Today/Done unless explicitly targeted.",
    inputSchema: {
      type: "object",
      properties: {
        noteTitle: { type: "string" }, section: { type: "string" },
        items: { type: "array", items: { type: "string" } },
      },
      required: ["noteTitle", "section", "items"],
    },
  },
  {
    name: "set_item_checked",
    description: "Set the checked state of a specific checklist item, matched by exact or fuzzy text.",
    inputSchema: {
      type: "object",
      properties: {
        noteTitle: { type: "string" }, itemText: { type: "string" }, checked: { type: "boolean" },
      },
      required: ["noteTitle", "itemText", "checked"],
    },
  },
  {
    name: "move_checked_items",
    description: "Move every currently-checked item out of the given source sections into the target section, preserving checked state.",
    inputSchema: {
      type: "object",
      properties: {
        noteTitle: { type: "string" },
        fromSections: { type: "array", items: { type: "string" } },
        toSection: { type: "string" },
      },
      required: ["noteTitle", "fromSections", "toSection"],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: a } = req.params as any;
  try {
    const result = await dispatch(name, a);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (e: any) {
    return { isError: true, content: [{ type: "text", text: `${e?.name ?? "Error"}: ${e?.message ?? e}` }] };
  }
});

async function dispatch(name: string, a: any) {
  switch (name) {
    case "read_note":
      return readNote(a.noteTitle);
    case "append_checklist_items":
      append(a.noteTitle, a.section, a.items);
      return verify(a.noteTitle);
    case "set_item_checked":
      setChecked(a.noteTitle, a.itemText, a.checked);
      return verify(a.noteTitle);
    case "move_checked_items":
      moveChecked(a.noteTitle, a.fromSections, a.toSection);
      return verify(a.noteTitle);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/** Re-read via the SQLite Reader after every mutation (verify-after-write). */
function verify(title: string) {
  return { ok: true, note: readNote(title) };
}

const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 2: Build**

Run: `cd server && npm run build && echo BUILD_OK`
Expected: `BUILD_OK`, `dist/index.js` exists.

- [ ] **Step 3: Smoke-test tool listing over stdio**

Run:
```bash
cd server && printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | node dist/index.js | head -40
```
Expected: JSON responses listing all four tools.

- [ ] **Step 4: Smoke-test read_note over stdio**

Run:
```bash
cd server && printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"read_note","arguments":{"noteTitle":"MCP Scratch List"}}}' \
  | node dist/index.js | tail -5
```
Expected: a `read_note` result with the scratch note's sections and checked state.

- [ ] **Step 5: Commit**

```bash
git add server/src/index.ts
git commit -m "server: MCP entrypoint, 4 tools registered, verify-after-write wiring"
```

### Task 17: Verify-after-write hardening + mutation smoke tests

**Files:**
- Modify: `server/src/index.ts`

- [ ] **Step 1: Strengthen `verify()` to confirm the intended change**

Replace `verify` with per-op verification: after `append`, confirm each new item text is present & unchecked in the target section; after `set_item_checked`, confirm the item's `checked` matches; after `move_checked_items`, confirm no checked items remain in `fromSections` and they now appear in `toSection`. On mismatch throw `VerifyError` with details.

```typescript
import { VerifyError } from "./errors.js";
// ... within dispatch, replace the return verify(...) calls with op-specific checks:
function verifyAppend(title: string, section: string, items: string[]) {
  const note = readNote(title);
  const sec = note.sections.find((s) => s.header === section);
  for (const it of items) {
    const found = sec?.items.find((i) => i.text === it);
    if (!found || found.checked) throw new VerifyError(`append not confirmed for "${it}"`);
  }
  return { ok: true, note };
}
// (analogous verifySetChecked / verifyMove)
```

- [ ] **Step 2: Run each mutation tool over stdio against the scratch note**

Repeat the Step-4-style stdio call for `append_checklist_items`, `set_item_checked`, and `move_checked_items` with scratch-note arguments. Expected: each returns `{ ok: true, note: … }` reflecting the change; no errors.

- [ ] **Step 3: Commit**

```bash
git add server/src/index.ts
git commit -m "server: per-operation verify-after-write with VerifyError on mismatch"
```

### Task 18: README + permissions docs

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Write `README.md`**

Include: what it does and the AppleScript limitation it works around; **exact** permission steps — Full Disk Access (System Settings → Privacy & Security → Full Disk Access) for the SQLite Reader, and Accessibility + Automation (System Settings → Privacy & Security → Accessibility / Automation) for the Writer, naming the host app (Conductor/Terminal); install/build (`cd server && npm install && npm run build`); MCP client config snippet pointing at `node /abs/path/server/dist/index.js`; the four tools with example arguments; and the Known Risks section from the spec (reverse-engineered format, re-verify after OS upgrades, always test on a scratch note).

- [ ] **Step 2: Verify the MCP config snippet actually launches**

Run: `node server/dist/index.js < /dev/null` and confirm it starts without throwing (Ctrl-C to exit) — proves the documented launch command is correct.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README with exact permission paths, setup, tools, and risks"
```

---

## Phase 5 — Acceptance

### Task 19: Full acceptance run on the scratch note

**Files:** none (verification only; may add notes to `docs/phase0-findings.md`)

- [ ] **Step 1: Run the full acceptance checklist**

Against `MCP Scratch List` only, verify each and record pass/fail:
- [ ] `read_note` matches on-screen state exactly, including checked items.
- [ ] `append_checklist_items` adds unchecked rows to the correct section only; title + other sections untouched.
- [ ] `set_item_checked` flips only the targeted row.
- [ ] `move_checked_items` relocates checked rows without disturbing unchecked siblings.
- [ ] Kill Notes.app mid-op (e.g. during a move), reopen — the note still opens and is not corrupted.
- [ ] README permission steps are accurate (follow them on a fresh check).

- [ ] **Step 2: Run the whole automated suite one final time**

Run: `cd server && npx vitest run`
Expected: all unit + integration tests PASS.

- [ ] **Step 3: Commit any final fixes**

```bash
git add -A && git commit -m "phase5: acceptance verified on scratch note"
```

- [ ] **Step 4: Report results and offer branch finishing**

Summarize acceptance results to the user; then use `superpowers:finishing-a-development-branch` to decide merge/PR/cleanup.

---

## Self-Review Notes

- **Spec coverage:** Problem/limitation (README Task 18); Reader subsystem (Tasks 5–10); Writer subsystem append/set/move/read + safety rails (Tasks 11–14, with Swift escalation Task 15); exact 4-tool surface (Task 16); verify-after-write (Tasks 16–17); project layout (Task 4 + file structure); all 6 build phases (Phases 0–5); every Phase-5 acceptance item (Task 19); every Known Risk (README Task 18). No gaps found.
- **Type consistency:** `Note`/`Section`/`Item`/`Paragraph`/`NoteRow`/`StyleType` defined once in `types.ts` (Task 4) and used unchanged throughout; `parseNoteProto`, `paragraphsToNote`, `resolveNote`, `findNoteRows`, `getNoteData`, `snapshotDb`, `readNote`, `append`, `setChecked`, `moveChecked`, `axRead`, `runOsascript` names are consistent across all tasks.
- **Empirical placeholders are intentional and bounded:** exact SQLite column names, protobuf enum values, and AX role names are confirmed in Phase 0 (Tasks 1–3) and the documented defaults are provided concretely so tasks are runnable as written, with a clear "adjust to Task N finding" instruction where device truth governs.
