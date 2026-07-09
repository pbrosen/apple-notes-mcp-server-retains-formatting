# Using the Apple Notes Checklist MCP server with Claude

This guide sets up the server so a Claude client (Claude Desktop, Claude Code, or any other
MCP-capable client) can read and edit your Apple Notes checklists.

> The steps below apply to **any** MCP client — the config shape (a command + args) and the macOS
> permission requirements are identical. Concrete examples are given for Claude Desktop and Claude
> Code; if your client is different, use the same server command with that client's MCP config.

---

## 0. What you need

- A Mac running macOS with Apple Notes signed in (developed/verified on **macOS 26.5.1, Notes 4.13**).
- **Node.js 18+** and **npm** — `node --version`
- **Swift toolchain** (ships with Xcode / Command Line Tools) — `swift --version`
- The note you want to manage should be a normal (not password‑locked) note, and its **title must
  be unique** among your notes.

---

## 1. Get the code and build it

```bash
git clone <REPO_URL> apple-notes-checklist-mcp
cd apple-notes-checklist-mcp
./scripts/setup.sh
```

`setup.sh` compiles the Swift helper and builds the server. When it finishes it prints two paths
you'll need:

- **Server entrypoint:** `.../server/dist/index.js`
- **Helper binary:** `.../helper/.build/release/notes-ax-helper`

(You can also build manually: `cd helper && swift build -c release`, then
`cd ../server && npm install && npm run build`.)

---

## 2. Grant macOS permissions — this is the important part

macOS grants these permissions to **the process that actually opens the files** — and that is
**not always the client app**. There are two cases:

- **Claude Desktop / Claude Cowork** launch the server through a wrapper that *disclaims*
  responsibility for the subprocess, so macOS checks the **`node` binary itself**. Granting the
  **Claude app** Full Disk Access does **nothing** here — you must grant the **`node` binary**.
  *(This is the confirmed, real-world setup.)*
- **Claude Code / a CLI run in Terminal or iTerm** — the terminal app is the responsible process, so
  granting **Terminal / iTerm** works.

If in doubt, grant the **`node` binary** — that works in every case.

### 2a. Find the exact `node` binary

> Order note: this needs the server process to exist, so **register it first (step 3), then come back
> here** — or skip discovery and just grant the common path `/usr/local/bin/node`.

With the server registered and the client running (so the server process exists), open **Terminal**:

```bash
ps aux | grep "apple-notes-checklist-mcp/server/dist/index.js"
# look for a line like: /usr/local/bin/node /Users/you/apple-notes-checklist-mcp/server/dist/index.js
realpath /usr/local/bin/node   # resolve symlinks (nvm/Homebrew often symlink node); use the result below
```

Use the resolved path (commonly `/usr/local/bin/node`, or an nvm/Homebrew path).

### 2b. Grant Full Disk Access + Accessibility to that binary

For **each** of System Settings → **Privacy & Security → Full Disk Access** and → **Accessibility**:

1. Click **+**.
2. In the file picker press **⌘⇧G**, paste the exact `node` path from step 2a, and select the binary.
3. Make sure its **toggle is on**.
4. **Fully quit (⌘Q) and relaunch** Claude Desktop / Claude so the server subprocess restarts under
   the new permission.

Full Disk Access lets the Reader read the Notes database; Accessibility lets the Writer drive Notes
(the Swift helper is spawned by `node`, so it inherits `node`'s Accessibility grant — no separate
entry needed). The first edit may also raise a one-time **"control Notes"** prompt — click **Allow**.

> ⚠️ **Security note:** granting Full Disk Access to your `node` binary grants it to **every** Node
> script that binary runs, not just this server — a broader grant than one app. That's your call to
> make. Given the access level, review the server source before wiring it into an automated/scheduled
> task, especially a recurring one that touches notes you rely on.

---

## 3. Add the server to your client

### Claude Desktop / Claude Cowork (Connectors UI — confirmed)

Claude Cowork bridges local MCP servers through the **Claude desktop app**, so you register the server
in Claude Desktop and Cowork picks up its tools automatically.

In the Claude app: **Settings → Connectors → Add connector → "Local command"**, then set:
- **Command:** `node`
- **Argument:** the absolute path to the server entrypoint, e.g.
  `/Users/you/apple-notes-checklist-mcp/server/dist/index.js`

Save, then **fully quit (⌘Q) and relaunch** Claude Desktop. The four tools (`read_note`,
`append_checklist_items`, `set_item_checked`, `move_checked_items`) then become available to Claude —
and to Cowork tasks that run through it.

> **Cowork can't do the setup for you.** Its sandbox is a separate environment; it can't run Terminal
> commands on your Mac, register connectors, or grant permissions. Steps 2 and 3 are yours to do by
> hand; once the tools appear, Cowork can use them (and, e.g., swap a computer-use task over to them).

**Alternative (config file):** some versions also read
`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "apple-notes-checklist": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/apple-notes-checklist-mcp/server/dist/index.js"]
    }
  }
}
```

### Claude Code (CLI)

```bash
claude mcp add apple-notes-checklist -- node /ABSOLUTE/PATH/TO/apple-notes-checklist-mcp/server/dist/index.js
```

Then in a session, `/mcp` should list `apple-notes-checklist` with its four tools. (Add `-s user`
to make it available in every project.)

> Optional: set `NOTES_AX_HELPER=/abs/path/to/notes-ax-helper` in the server's environment if you
> move the helper binary elsewhere.

---

## 4. Verify it works (on a scratch note first!)

Create a disposable note titled e.g. **"MCP Test"** with a couple of headings and checklist items,
then ask Claude:

> "Read my note 'MCP Test' and show me the sections and which items are checked."

You should get back the structure with correct checked/unchecked state. **Always try the write tools
on a throwaway note before pointing them at a note you care about.**

---

## 5. What you can ask Claude to do

The server exposes four tools; you drive them with plain language. Examples:

**Read structure + checked state**
> "What's on my 'Groceries' note? Which items are already checked?"
→ `read_note`

**Add new (unchecked) items to a section**
> "Add 'call the vet' and 'buy stamps' to the Errands section of my 'To‑Do' note."
→ `append_checklist_items` (new items always land **unchecked**, only in that section)

**Check or uncheck a specific item**
> "Mark 'buy stamps' as done in my 'To‑Do' note."
> "Uncheck 'call the vet'."
→ `set_item_checked` (matches by exact or fuzzy text; it's a no‑op if already in that state)

**Sweep completed items into a Done section**
> "Move everything that's checked in Today and This Week into the Done section of my 'To‑Do' note."
→ `move_checked_items` (moved items keep their checked state; unchecked items aren't touched)

Behavior notes:
- A **section header** is any non‑empty, non‑checklist line (the note's first line is its title). A
  Notes "Heading"‑styled line works too.
- Every edit is **verified** by re‑reading the note before reporting success, and edits never touch
  the title or other sections.
- Keep Notes open and visible while writing — the edits drive Notes' own editor.

---

## 6. Which note structures work

Reading the **checked/unchecked state is reliable regardless of layout** (it comes from Apple's data,
not from guessing). The *grouping* into sections assumes: first line = title; any non-empty,
non-checklist line = a section header; checklist rows belong to the header above them.

- **Works well:** section labels as plain text or Notes "Heading" style; one, many, or zero sections;
  any checked/unchecked mix.
- **Can be misread** (any non-checklist line becomes a "header"): prose written between checklist
  items; bulleted/numbered lists mixed in; nested/indented sub-items (flattened — state kept,
  hierarchy lost); tables/images/attachments.
- **Duplicates:** if two sections or two items share the same text, the write tools refuse and ask you
  to disambiguate rather than edit the wrong line.

It's built for the common "optional section labels + checklist items" to-do pattern. Freeform notes
still read their checkboxes correctly but may report extra sections. If your note is more complex,
try the read tool first to see how it's interpreted before using the write tools.

## 7. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Full Disk Access is not granted` (esp. on Claude Desktop/Cowork after granting the *app*) | Grant FDA to the **`node` binary**, not the Claude app (step 2/2a), then fully quit + relaunch. |
| `Accessibility permission not granted` | Grant Accessibility to the same **`node` binary** (step 2), then fully quit + relaunch. |
| Granted the Claude app but still denied | Expected — Claude Desktop disclaims responsibility for the subprocess; grant the **`node` binary** instead. |
| A "control Notes" prompt appears | Click **Allow** — that's the one‑time Automation grant. |
| `No note titled "X" found` | Title must match exactly and not be in Recently Deleted. |
| `Multiple notes titled "X" found` | Titles must be unique — rename one. The error lists the duplicates. |
| `Section "X" not found` | The header text must match a line in the note exactly. |
| `AX helper not built` | Run `./scripts/setup.sh` (or `swift build -c release` in `helper/`). |
| `wrong note is open` | The server opens the target note automatically; if you see this, make sure Notes isn't blocked by a dialog and retry. |
| Nothing happens / edits land oddly | Make sure Notes is the frontmost app and not mid‑search; don't type in Notes while an edit runs. |

---

## 8. Important caveats

- This reads a **reverse‑engineered, undocumented** on‑disk format. It's verified for macOS 26 /
  Notes 4.13; a major macOS/Notes update could change the format. If reads start returning wrong
  data after an upgrade, re‑run the Phase 0 probe (see `docs/phase0-findings.md`).
- Writing is UI automation through the Accessibility API. It never writes the Notes database
  directly, so an interrupted edit can't corrupt your store — but it can leave a half‑typed line,
  just like being interrupted while typing.
- **Known issue:** appended items can render **bold** (Notes bolds a checklist paragraph when it's
  finalized via automation). The text, unchecked state, and section are correct; only the styling is
  affected, and existing items aren't touched. A fix is still being investigated — see the README.
- **Validate on a disposable note before using it on anything you rely on.**
