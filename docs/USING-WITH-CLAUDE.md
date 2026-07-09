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

The two permissions must be granted to **the app that launches the server process**, not to the
server itself. That app is your MCP client:

| If you run the server via… | Grant permissions to… |
|---|---|
| **Claude Desktop** | the **Claude** app |
| **Claude Code / any CLI** in Terminal | **Terminal** (or iTerm, etc.) |
| a different host app | that host app |

Grant both:

1. **Full Disk Access** — lets the Reader read `NoteStore.sqlite`.
   System Settings → **Privacy & Security → Full Disk Access** → toggle on your client app (click
   **+** and add it if it's not listed).
2. **Accessibility** — lets the Writer drive Notes.
   System Settings → **Privacy & Security → Accessibility** → toggle on the same app.

The first time the server edits a note you may also get a one‑time prompt
**"<app> wants to control Notes"** — click **Allow** (this is the Automation permission; you can
review it later under Privacy & Security → Automation).

If you toggled a permission while the client was running, **quit and reopen the client** so it picks
up the change. (The Swift helper inherits the client's Accessibility grant — it does not need its own
entry.)

---

## 3. Add the server to your client

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (create it if missing) and add
the server, using the **absolute** path printed by `setup.sh`:

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

Quit and reopen Claude Desktop. You should see the four tools available (look for the tools/plug
icon).

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

## 6. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Full Disk Access is not granted` | Grant FDA to your client app (step 2), then quit + reopen it. |
| `Accessibility permission not granted` | Grant Accessibility to your client app (step 2), then restart it. |
| A "control Notes" prompt appears | Click **Allow** — that's the one‑time Automation grant. |
| `No note titled "X" found` | Title must match exactly and not be in Recently Deleted. |
| `Multiple notes titled "X" found` | Titles must be unique — rename one. The error lists the duplicates. |
| `Section "X" not found` | The header text must match a line in the note exactly. |
| `AX helper not built` | Run `./scripts/setup.sh` (or `swift build -c release` in `helper/`). |
| `wrong note is open` | The server opens the target note automatically; if you see this, make sure Notes isn't blocked by a dialog and retry. |
| Nothing happens / edits land oddly | Make sure Notes is the frontmost app and not mid‑search; don't type in Notes while an edit runs. |

---

## 7. Important caveats

- This reads a **reverse‑engineered, undocumented** on‑disk format. It's verified for macOS 26 /
  Notes 4.13; a major macOS/Notes update could change the format. If reads start returning wrong
  data after an upgrade, re‑run the Phase 0 probe (see `docs/phase0-findings.md`).
- Writing is UI automation through the Accessibility API. It never writes the Notes database
  directly, so an interrupted edit can't corrupt your store — but it can leave a half‑typed line,
  just like being interrupted while typing.
- **Validate on a disposable note before using it on anything you rely on.**
