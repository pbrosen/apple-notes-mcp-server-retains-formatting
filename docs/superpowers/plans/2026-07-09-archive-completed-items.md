# Archive Completed Items — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `archive_completed_items` MCP tool that moves every checked item from a source note into a separate "Completed To-Do's" note (created if missing), placed at the top and kept checked.

**Architecture:** Additive. A new orchestration module (`archive.ts`) reads the source via the SQLite Reader, ensures the destination note exists (creating it via AppleScript), and moves each checked item source→top-of-destination using new Swift helper ops (`copy_line` / `paste_at_top` / `delete_line`) with a copy → verify → delete safety sequence. Existing read/append/check/move paths are untouched.

**Tech Stack:** TypeScript (Node), `@modelcontextprotocol/sdk`, Swift Accessibility helper, `osascript` for note create/open, `vitest`.

**Source spec:** `docs/superpowers/specs/2026-07-09-archive-completed-items-design.md`

---

## File Structure

```
server/src/
  util.ts                 # NEW: sleepSync (shared, no deps)
  writer/
    notesApp.ts           # NEW: openNote (moved here) + createNote  (AppleScript note ops)
    archive.ts            # NEW: checkedItemTexts (pure) + archiveCompletedItems (orchestration)
    writer.ts             # MODIFY: import openNote from notesApp, sleepSync from util; export readNoteUntil
    helper.ts             # unchanged (runHelper)
  index.ts                # MODIFY: register + dispatch archive_completed_items
  reader/reader.ts        # unchanged (readNote)
helper/Sources/notes-ax-helper/main.swift   # MODIFY: add copy_line / paste_at_top / delete_line ops + key constants
server/test/
  archive.test.ts         # NEW: unit test for checkedItemTexts
```

No import cycles: `util` (leaf) ← `notesApp`, `writer`, `archive`; `notesApp` (leaf but for util) ← `writer`, `archive`; `archive` → `writer` (for `readNoteUntil`), `notesApp`, `helper`, `reader`.

---

## Task 1: Extract shared helpers (sleepSync, openNote) so archive can reuse them

**Files:**
- Create: `server/src/util.ts`
- Create: `server/src/writer/notesApp.ts`
- Modify: `server/src/writer/writer.ts`

- [ ] **Step 1: Create `server/src/util.ts`**

```typescript
/** Synchronous sleep (the Writer/archive paths are fully synchronous). */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
```

- [ ] **Step 2: Create `server/src/writer/notesApp.ts`** (move `openNote` here verbatim from `writer.ts`, add `createNote`)

```typescript
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
```

- [ ] **Step 3: Update `server/src/writer/writer.ts`** — remove the local `sleepSync` and `openNote` definitions; import them; export `readNoteUntil`.

Replace the top imports block:
```typescript
import { execFileSync } from "node:child_process";
import { readNote } from "../reader/reader.js";
import { runHelper } from "./helper.js";
import { PermissionError, StructureError, VerifyError } from "../errors.js";
import type { Note, Section, Item } from "../types.js";
```
with:
```typescript
import { readNote } from "../reader/reader.js";
import { runHelper } from "./helper.js";
import { StructureError, VerifyError } from "../errors.js";
import { sleepSync } from "../util.js";
import { openNote } from "./notesApp.js";
import type { Note, Section, Item } from "../types.js";
```

Delete the local `function openNote(...) { ... }` block and the local `function sleepSync(...) { ... }` block from `writer.ts` (now imported).

Change `function readNoteUntil(` to `export function readNoteUntil(` so `archive.ts` can reuse it.

- [ ] **Step 4: Build + type-check**

Run: `cd server && npx tsc --noEmit && echo TYPECHECK_OK`
Expected: `TYPECHECK_OK` (no unused-import or missing-symbol errors).

- [ ] **Step 5: Run existing tests (no regression)**

Run: `cd server && npx vitest run`
Expected: all tests PASS (16).

- [ ] **Step 6: Live regression smoke — the existing writer still works**

Run (appends a throwaway item, expects it to land):
```bash
cd server && cat > _smoke.ts <<'EOF'
import { append } from "./src/writer/writer.js";
import { readNote } from "./src/reader/reader.js";
try { append("MCP Scratch List", "Personal", ["refactor smoke check"]); } catch(e){ console.log("verify:", (e as Error).message); }
const p = readNote("MCP Scratch List").sections.find(s=>s.header==="Personal");
console.log("present:", !!p?.items.find(i=>i.text==="refactor smoke check"));
EOF
npx tsx _smoke.ts; rm -f _smoke.ts
```
Expected: prints `present: true` (the existing append path still works after the refactor).

- [ ] **Step 7: Commit**

```bash
git add server/src/util.ts server/src/writer/notesApp.ts server/src/writer/writer.ts
git commit -m "refactor: extract sleepSync + openNote (notesApp), add createNote, export readNoteUntil"
```

---

## Task 2: `checkedItemTexts` — collect all checked items in source order (pure, TDD)

**Files:**
- Create: `server/src/writer/archive.ts`
- Create: `server/test/archive.test.ts`

- [ ] **Step 1: Write the failing test `server/test/archive.test.ts`**

```typescript
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && npx vitest run test/archive.test.ts`
Expected: FAIL — cannot find `checkedItemTexts` in `../src/writer/archive.js`.

- [ ] **Step 3: Create `server/src/writer/archive.ts` with just the pure function**

```typescript
import type { Note } from "../types.js";

/** All checked item texts across every section, in top-to-bottom (source) order. */
export function checkedItemTexts(note: Note): string[] {
  return note.sections.flatMap((s) => s.items).filter((i) => i.checked).map((i) => i.text);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx vitest run test/archive.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/writer/archive.ts server/test/archive.test.ts
git commit -m "archive: checkedItemTexts (collect checked items in source order)"
```

---

## Task 3: Swift helper ops — copy_line / paste_at_top / delete_line

**Files:**
- Modify: `helper/Sources/notes-ax-helper/main.swift`

- [ ] **Step 1: Add key constants** next to the existing `KEY_*` constants (`KEY_RETURN` etc.)

```swift
let KEY_C: CGKeyCode = 8
let KEY_DELETE: CGKeyCode = 51 // Backspace — deletes the current selection
```

- [ ] **Step 2: Add the three op cases** before `default:` in the `switch op` block

```swift
case "copy_line":
  guard let lineText = json["lineText"] as? String else { fail("copy_line: missing lineText") }
  verifyFrontNote(ta, json)
  focusEditor(notes, ta)
  let text = getText(ta)
  guard let (loc, len) = lineRange(text, lineText) else {
    fail("copy_line: line not found or ambiguous: \(lineText)")
  }
  let ns = text as NSString
  // include the trailing newline so the clipboard carries a whole checklist paragraph (style + checked)
  let includeNL = (loc + len) < ns.length
  if !setSelection(ta, loc, len + (includeNL ? 1 : 0)) { fail("copy_line: could not select") }
  usleep(40_000)
  key(KEY_C, [.maskCommand])
  ok()

case "paste_at_top":
  verifyFrontNote(ta, json)
  focusEditor(notes, ta)
  let text = getText(ta)
  let ns = text as NSString
  let firstNL = ns.range(of: "\n")
  let titleLen = firstNL.location != NSNotFound ? firstNL.location : ns.length
  if firstNL.location != NSNotFound {
    // there is a line after the title: insert the clipboard paragraph at the start of that line
    let at = min(titleLen + 1, ns.length)
    if !setSelection(ta, at, 0) { fail("paste_at_top: could not position") }
    usleep(40_000)
    key(KEY_V, [.maskCommand])
  } else {
    // title-only note: go to end of the title line, add a newline, then paste
    if !setSelection(ta, titleLen, 0) { fail("paste_at_top: could not position") }
    usleep(40_000)
    key(KEY_RETURN)
    key(KEY_V, [.maskCommand])
  }
  ok()

case "delete_line":
  guard let lineText = json["lineText"] as? String else { fail("delete_line: missing lineText") }
  verifyFrontNote(ta, json)
  focusEditor(notes, ta)
  let text = getText(ta)
  guard let (loc, len) = lineRange(text, lineText) else {
    fail("delete_line: line not found or ambiguous: \(lineText)")
  }
  let ns = text as NSString
  let includeNL = (loc + len) < ns.length
  if !setSelection(ta, loc, len + (includeNL ? 1 : 0)) { fail("delete_line: could not select") }
  usleep(40_000)
  key(KEY_DELETE) // deletes the selection
  ok()
```

- [ ] **Step 3: Build the helper**

Run: `cd helper && swift build -c release`
Expected: `Build complete!`

- [ ] **Step 4: Live-test the ops on the scratch note**

Manually create/prepare: ensure `MCP Scratch List` has at least one checked item (e.g. use the `toggle` op or check one in Notes). Then, replacing `<checked item text>` with a real checked item:
```bash
cd helper && H=.build/release/notes-ax-helper
node -e 'process.stdout.write(JSON.stringify({op:"copy_line",expectTitle:"MCP Scratch List",lineText:"<checked item text>"}))' | $H; echo ""
# paste it at the top of the SAME note as a quick sanity check of the paste path
node -e 'process.stdout.write(JSON.stringify({op:"paste_at_top",expectTitle:"MCP Scratch List"}))' | $H; echo ""
```
Expected: both return `{"ok":true}`; visually, a copy of the item appears directly under the note title, still a checklist item (used only to confirm the ops work; the real flow is tested in Task 5). Then delete that test copy:
```bash
node -e 'process.stdout.write(JSON.stringify({op:"delete_line",expectTitle:"MCP Scratch List",lineText:"<checked item text>"}))' | $H; echo ""
```
Expected: `{"ok":true}`; one occurrence removed. If `paste_at_top` produces a stray blank line or merges with the title, adjust the positioning in Step 2 and rebuild before continuing.

- [ ] **Step 5: Commit**

```bash
git add helper/Sources/notes-ax-helper/main.swift
git commit -m "writer: Swift helper ops copy_line / paste_at_top / delete_line"
```

---

## Task 4: `archiveCompletedItems` orchestration + register the tool

**Files:**
- Modify: `server/src/writer/archive.ts`
- Modify: `server/src/index.ts`

- [ ] **Step 1: Add `archiveCompletedItems` to `server/src/writer/archive.ts`**

```typescript
import { readNote } from "../reader/reader.js";
import { readNoteUntil } from "./writer.js";
import { openNote, createNote } from "./notesApp.js";
import { runHelper } from "./helper.js";
import { NoteNotFoundError, StructureError, VerifyError } from "../errors.js";
import { sleepSync } from "../util.js";
import type { Note } from "../types.js";

function hasItem(note: Note, text: string): boolean {
  return note.sections.some((s) => s.items.some((i) => i.text === text));
}

/** Poll until `title` is readable (tolerating NoteNotFoundError while iCloud/Notes flushes). */
function pollUntilReadable(title: string, timeoutMs = 5000, intervalMs = 300): Note | null {
  const start = Date.now();
  for (;;) {
    try {
      return readNote(title);
    } catch (e) {
      if (!(e instanceof NoteNotFoundError)) throw e;
    }
    if (Date.now() - start > timeoutMs) return null;
    sleepSync(intervalMs);
  }
}

/**
 * Move every checked item from `sourceTitle` into the archive note (default "Completed To-Do's"),
 * at the top, keeping them checked. Creates the archive note if it doesn't exist. For each item:
 * copy → paste into archive → verify → then delete from source (never lose a task on failure).
 */
export function archiveCompletedItems(sourceTitle: string, archiveTitleArg?: string) {
  const archiveTitle = (archiveTitleArg && archiveTitleArg.trim()) || "Completed To-Do's";
  if (archiveTitle === sourceTitle) {
    throw new StructureError(`Archive note must be different from the source note ("${sourceTitle}").`);
  }

  const source = readNote(sourceTitle); // throws NoteNotFound/Ambiguous as usual
  const checked = checkedItemTexts(source);
  if (checked.length === 0) {
    return { ok: true, archived: 0, archiveNoteTitle: archiveTitle, createdArchive: false, note: source };
  }

  // Ensure the destination exists.
  let createdArchive = false;
  let dest: Note | null = null;
  try {
    dest = readNote(archiveTitle);
  } catch (e) {
    if (!(e instanceof NoteNotFoundError)) throw e; // AmbiguousNoteError etc. propagate
  }
  if (dest === null) {
    createNote(archiveTitle);
    createdArchive = true;
    dest = pollUntilReadable(archiveTitle);
    if (dest === null) throw new StructureError(`Could not create or read archive note "${archiveTitle}".`);
  }

  // Move each checked item, in REVERSE source order, so the batch reads source-order at the top.
  for (const text of [...checked].reverse()) {
    openNote(sourceTitle);
    runHelper({ op: "copy_line", expectTitle: sourceTitle, lineText: text });

    openNote(archiveTitle);
    runHelper({ op: "paste_at_top", expectTitle: archiveTitle });
    const inDest = readNoteUntil(archiveTitle, (n) => hasItem(n, text));
    if (!hasItem(inDest, text)) {
      throw new VerifyError(`Archive not confirmed: "${text}" did not appear in "${archiveTitle}"; source left unchanged.`);
    }

    openNote(sourceTitle);
    runHelper({ op: "delete_line", expectTitle: sourceTitle, lineText: text });
    const src2 = readNoteUntil(sourceTitle, (n) => !hasItem(n, text));
    if (hasItem(src2, text)) {
      throw new VerifyError(`"${text}" was copied to "${archiveTitle}" but not removed from "${sourceTitle}"; check both notes.`);
    }
  }

  return {
    ok: true,
    archived: checked.length,
    archiveNoteTitle: archiveTitle,
    createdArchive,
    note: readNote(sourceTitle),
  };
}
```
(Keep the existing `checkedItemTexts` export at the top of the file.)

- [ ] **Step 2: Register the tool in `server/src/index.ts`** — add to the `TOOLS` array:

```typescript
  {
    name: "archive_completed_items",
    description:
      "Move every checked item from a source note into a separate completed-tasks note, placed at the top and kept checked. Creates the destination note if it doesn't exist. archiveNoteTitle is optional (defaults to \"Completed To-Do's\").",
    inputSchema: {
      type: "object",
      properties: {
        noteTitle: { type: "string" },
        archiveNoteTitle: { type: "string" },
      },
      required: ["noteTitle"],
    },
  },
```

- [ ] **Step 3: Dispatch it in `server/src/index.ts`** — add the import and case:

```typescript
import { archiveCompletedItems } from "./writer/archive.js";
```
and inside `dispatch()`'s `switch (name)`:
```typescript
    case "archive_completed_items":
      return archiveCompletedItems(a.noteTitle as string, a.archiveNoteTitle as string | undefined);
```

- [ ] **Step 4: Build + full test suite**

Run: `cd server && npm run build && npx vitest run`
Expected: `dist/` builds; all unit tests PASS (18).

- [ ] **Step 5: Smoke-test tool registration over stdio**

Run:
```bash
cd server && printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | node dist/index.js 2>/dev/null | grep -o 'archive_completed_items'
```
Expected: prints `archive_completed_items`.

- [ ] **Step 6: Commit**

```bash
git add server/src/writer/archive.ts server/src/index.ts
git commit -m "archive: archive_completed_items tool (copy/verify/delete cross-note move)"
```

---

## Task 5: Live acceptance on two disposable scratch notes

**Files:** none (verification only)

- [ ] **Step 1: Prepare a disposable SOURCE note**

In Notes, ensure `MCP Scratch List` (or make a fresh `Archive Test Src`) has a few checked and a few unchecked items across ≥2 sections. Make sure NO note named `Completed To-Do's` exists yet (so create-if-missing is exercised) — if one exists, delete it or use a unique archive name for the test.

- [ ] **Step 2: Run the archive flow and verify**

```bash
cd server && cat > _acc.ts <<'EOF'
import { archiveCompletedItems, checkedItemTexts } from "./src/writer/archive.js";
import { readNote } from "./src/reader/reader.js";
const SRC = "MCP Scratch List";
const before = readNote(SRC);
const willArchive = checkedItemTexts(before);
console.log("to archive (source order):", JSON.stringify(willArchive));
const res = archiveCompletedItems(SRC); // default destination "Completed To-Do's"
console.log("result:", JSON.stringify({archived:res.archived, dest:res.archiveNoteTitle, created:res.createdArchive}));
const dest = readNote("Completed To-Do's");
const destItems = dest.sections.flatMap(s=>s.items);
console.log("archive top items:", JSON.stringify(dest.sections.flatMap(s=>s.items.map(i=>`${i.checked?'[x]':'[ ]'}${i.text}`)).slice(0,willArchive.length)));
console.log("all archived present & checked:", willArchive.every(t => destItems.find(i=>i.text===t)?.checked === true));
const src = readNote(SRC);
console.log("source now has 0 checked:", checkedItemTexts(src).length === 0);
EOF
npx tsx _acc.ts; rm -f _acc.ts
```
Expected: `created: true`; the archive's top items equal `willArchive` **in source order**, each `[x]` (checked); "all archived present & checked" = `true`; "source now has 0 checked" = `true`.

- [ ] **Step 3: Verify ordering + not-bold, and idempotent no-op**

- Confirm visually in Notes that the archived items sit directly under the `Completed To-Do's` title, in source order, **not bold** (they were pasted, not typed).
- Run again with everything already archived:
```bash
cd server && npx tsx -e 'import {archiveCompletedItems} from "./src/writer/archive.js"; console.log(JSON.stringify(archiveCompletedItems("MCP Scratch List")));'
```
Expected: `{"ok":true,"archived":0,...}` — clean no-op (nothing checked left).

- [ ] **Step 4: Verify the safety ordering (copy-before-delete)**

Reason-check against the code: `delete_line` only runs after `readNoteUntil(archive, hasItem)` confirms the item is in the archive. Confirm by reading Task 4's loop — if the paste-verify throws, the `delete_line` for that item never runs, so the source item is retained. (No destructive test needed; the ordering guarantees it.)

- [ ] **Step 5: Deploy to the durable install + final commit**

```bash
# update the always-on copy Cowork uses
cd "$HOME/apple-notes-checklist-mcp" && git pull --ff-only && ./scripts/setup.sh
```
Then commit any final notes and use `superpowers:finishing-a-development-branch`.

---

## Self-Review

- **Spec coverage:** default "Completed To-Do's" + optional name (Task 4 `archiveTitleArg`); create-if-missing (Task 4 `createNote` + `pollUntilReadable`); all checked items, all sections (Task 2 `checkedItemTexts`); kept checked via paste (Task 3 `copy_line`/`paste_at_top`); top-of-note in source order (Task 3 `paste_at_top` + Task 4 reverse-iteration); copy→verify→delete safety (Task 4 loop); destination≠source guard (Task 4); tool surface (Task 4); errors — not found/ambiguous propagate, permissions typed (Tasks 1/4); testing (Tasks 2 unit + 5 live). No gaps.
- **Placeholder scan:** the only `<checked item text>` placeholders are in Task 3 Step 4's *manual live* command where the engineer substitutes a real item — intentional, not a code placeholder. No TBD/TODO in code.
- **Type consistency:** `checkedItemTexts`, `archiveCompletedItems`, `openNote`, `createNote`, `readNoteUntil`, `runHelper`, `sleepSync`, `hasItem`, `pollUntilReadable` names consistent across tasks; helper op names (`copy_line`, `paste_at_top`, `delete_line`) match between Swift (Task 3) and the `runHelper({op:...})` calls (Task 4); `expectTitle`/`lineText` params match the guard in the Swift ops.
