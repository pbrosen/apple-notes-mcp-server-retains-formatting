import AppKit
import ApplicationServices

// notes-ax-helper: JSON-in (stdin) / JSON-out (stdout) executor for Apple Notes checklist
// edits via the Accessibility API. The MCP server (TypeScript) computes WHAT to do using the
// SQLite Reader; this helper does the AX positioning + synthetic key events.
//
// Operations (op field):
//   {"op":"read"}
//       -> {"ok":true,"text":"<full editor text>"}
//   {"op":"append","afterLineText":"...","anchorIsChecklist":true,"items":["a","b"]}
//       -> {"ok":true}
//   {"op":"toggle","lineText":"...","desiredChecked":true,"currentChecked":false}
//       -> {"ok":true,"toggled":true}
//   {"op":"move","lineText":"...","toAfterLineText":"...","toAnchorIsChecklist":true}
//       -> {"ok":true}
//
// Lines are located by EXACT text match; 0 or >1 matches is an error (caller ensures unique).

// ---------- JSON output helpers ----------
func emit(_ obj: [String: Any]) -> Never {
  let data = try! JSONSerialization.data(withJSONObject: obj)
  FileHandle.standardOutput.write(data)
  exit((obj["ok"] as? Bool) == true ? 0 : 1)
}
func ok(_ extra: [String: Any] = [:]) -> Never {
  var o: [String: Any] = ["ok": true]; for (k, v) in extra { o[k] = v }; emit(o)
}
func fail(_ msg: String) -> Never { emit(["ok": false, "error": msg]) }

// ---------- AX helpers ----------
func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
  var v: AnyObject?
  return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}
func role(_ el: AXUIElement) -> String { (attr(el, kAXRoleAttribute as String) as? String) ?? "?" }
func children(_ el: AXUIElement) -> [AXUIElement] {
  (attr(el, kAXChildrenAttribute as String) as? [AXUIElement]) ?? []
}
func firstChild(_ el: AXUIElement, _ r: String) -> AXUIElement? { children(el).first { role($0) == r } }
func allChildren(_ el: AXUIElement, _ r: String) -> [AXUIElement] { children(el).filter { role($0) == r } }

func findTextArea(_ app: AXUIElement) -> AXUIElement? {
  // Search every window for the one that actually contains the note editor (a split group whose
  // last scroll area holds a text area). Don't assume the editor is the frontmost window — Notes
  // can have stray/secondary windows in front.
  for win in allChildren(app, "AXWindow") {
    if let split = firstChild(win, "AXSplitGroup"),
       let editor = allChildren(split, "AXScrollArea").last,
       let ta = firstChild(editor, "AXTextArea") {
      return ta
    }
  }
  return nil
}

func getText(_ ta: AXUIElement) -> String { (attr(ta, kAXValueAttribute as String) as? String) ?? "" }

func setSelection(_ ta: AXUIElement, _ loc: Int, _ len: Int) -> Bool {
  var r = CFRange(location: loc, length: len)
  guard let v = AXValueCreate(.cfRange, &r) else { return false }
  return AXUIElementSetAttributeValue(ta, kAXSelectedTextRangeAttribute as CFString, v) == .success
}

// Find the UTF-16 (location,length) of the single line whose text exactly equals `target`.
// Returns nil if not found or ambiguous.
func lineRange(_ text: String, _ target: String) -> (loc: Int, len: Int)? {
  let lines = text.components(separatedBy: "\n")
  var offset = 0
  var found: (Int, Int)? = nil
  var count = 0
  for line in lines {
    let len = (line as NSString).length
    if line == target { found = (offset, len); count += 1 }
    offset += len + 1 // + newline
  }
  return count == 1 ? found : nil
}

// ---------- synthetic key events ----------
let src = CGEventSource(stateID: .hidSystemState)
func key(_ vk: CGKeyCode, _ flags: CGEventFlags = []) {
  if let d = CGEvent(keyboardEventSource: src, virtualKey: vk, keyDown: true) {
    d.flags = flags; d.post(tap: .cghidEventTap)
  }
  if let u = CGEvent(keyboardEventSource: src, virtualKey: vk, keyDown: false) {
    u.flags = flags; u.post(tap: .cghidEventTap)
  }
  usleep(40_000)
}
func typeText(_ s: String) {
  var utf16 = Array(s.utf16)
  if let d = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true) {
    d.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
    d.post(tap: .cghidEventTap)
  }
  if let u = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false) {
    u.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
    u.post(tap: .cghidEventTap)
  }
  usleep(40_000)
}
let KEY_RETURN: CGKeyCode = 36
let KEY_U: CGKeyCode = 32
let KEY_L: CGKeyCode = 37
let KEY_X: CGKeyCode = 7
let KEY_V: CGKeyCode = 9
let KEY_C: CGKeyCode = 8

// Guard against editing the wrong note: the editor operates on whatever note is frontmost, so
// confirm the front note's title (its first line) matches what the caller expects.
func verifyFrontNote(_ ta: AXUIElement, _ json: [String: Any]) {
  guard let expect = json["expectTitle"] as? String else { return }
  let first = getText(ta).components(separatedBy: "\n").first ?? ""
  if first != expect {
    fail("wrong note is open: front note is \"\(first)\", expected \"\(expect)\". Open that note in Notes, then retry.")
  }
}

func focusEditor(_ notes: NSRunningApplication, _ ta: AXUIElement) {
  notes.activate(options: [])
  AXUIElementSetAttributeValue(ta, kAXFocusedAttribute as CFString, kCFBooleanTrue)
  usleep(120_000)
}

// ---------- read input ----------
let input = FileHandle.standardInput.readDataToEndOfFile()
guard let json = try? JSONSerialization.jsonObject(with: input) as? [String: Any],
      let op = json["op"] as? String else {
  fail("invalid JSON input or missing 'op'")
}

guard let notes = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.Notes").first else {
  fail("Notes.app is not running")
}
if !AXIsProcessTrusted() {
  fail("Accessibility permission not granted for the process running this helper (grant it in System Settings → Privacy & Security → Accessibility).")
}
let app = AXUIElementCreateApplication(notes.processIdentifier)
guard let ta = findTextArea(app) else { fail("could not locate the Notes editor text area (is a note open?)") }

switch op {
case "read":
  ok(["text": getText(ta)])

case "append":
  guard let afterLineText = json["afterLineText"] as? String,
        let items = json["items"] as? [String] else { fail("append: missing afterLineText/items") }
  let anchorIsChecklist = (json["anchorIsChecklist"] as? Bool) ?? true
  verifyFrontNote(ta, json)
  focusEditor(notes, ta)
  let text = getText(ta)
  guard let (loc, len) = lineRange(text, afterLineText) else {
    fail("append: anchor line not found or ambiguous: \(afterLineText)")
  }
  // cursor to end of the anchor line
  if !setSelection(ta, loc + len, 0) { fail("append: could not set selection") }
  usleep(40_000)
  for (i, item) in items.enumerated() {
    key(KEY_RETURN)
    // If appending after a non-checklist anchor (empty section header), the first new line is
    // a plain paragraph; turn it into a checklist. Subsequent lines continue as checklists.
    if i == 0 && !anchorIsChecklist {
      key(KEY_L, [.maskShift, .maskCommand])
    }
    typeText(item)
  }
  ok()

case "toggle":
  guard let lineText = json["lineText"] as? String else { fail("toggle: missing lineText") }
  let desired = (json["desiredChecked"] as? Bool) ?? false
  let current = (json["currentChecked"] as? Bool) ?? false
  if desired == current { ok(["toggled": false]) }
  verifyFrontNote(ta, json)
  focusEditor(notes, ta)
  let text = getText(ta)
  guard let (loc, len) = lineRange(text, lineText) else {
    fail("toggle: line not found or ambiguous: \(lineText)")
  }
  // place cursor within the line, then Mark as Checked (⇧⌘U) toggles its state
  if !setSelection(ta, loc + min(1, len), 0) { fail("toggle: could not set selection") }
  usleep(40_000)
  key(KEY_U, [.maskShift, .maskCommand])
  ok(["toggled": true])

case "move":
  guard let lineText = json["lineText"] as? String,
        let toAfterLineText = json["toAfterLineText"] as? String else {
    fail("move: missing lineText/toAfterLineText")
  }
  verifyFrontNote(ta, json)
  focusEditor(notes, ta)
  let text = getText(ta)
  guard let (loc, len) = lineRange(text, lineText) else {
    fail("move: source line not found or ambiguous: \(lineText)")
  }
  // select the whole paragraph incl. trailing newline (preserves checklist+checked on cut)
  let ns = text as NSString
  let includeNewline = (loc + len) < ns.length // false if source is the very last line
  if !setSelection(ta, loc, len + (includeNewline ? 1 : 0)) { fail("move: could not select source") }
  usleep(40_000)
  key(KEY_X, [.maskCommand]) // cut
  usleep(80_000)
  // re-read (offsets shifted) and find the target section's last line
  let text2 = getText(ta)
  guard let (tloc, tlen) = lineRange(text2, toAfterLineText) else {
    fail("move: target anchor not found or ambiguous after cut: \(toAfterLineText)")
  }
  let ns2 = text2 as NSString
  let afterTarget = tloc + tlen
  if afterTarget < ns2.length {
    // paste at start of the line following the target's last item
    if !setSelection(ta, afterTarget + 1, 0) { fail("move: could not position at target") }
    usleep(40_000)
    key(KEY_V, [.maskCommand])
  } else {
    // target is the last line of the note: go to end, add a newline, then paste
    if !setSelection(ta, afterTarget, 0) { fail("move: could not position at end") }
    usleep(40_000)
    key(KEY_RETURN)
    key(KEY_V, [.maskCommand])
  }
  ok()

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
  // Position at the end of the title line and open a fresh line, THEN paste. Pasting a checklist
  // paragraph at the start of an existing checklist line merges the two; pasting into a fresh line
  // does not.
  if !setSelection(ta, titleLen, 0) { fail("paste_at_top: could not position") }
  usleep(40_000)
  key(KEY_RETURN)
  key(KEY_V, [.maskCommand])
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
  // Remove the selection via ⌘X (proven to reliably delete a selected line, unlike a synthetic
  // Backspace). It overwrites the clipboard, which is fine — the archive flow already pasted this
  // item before deleting, and the next item does its own copy.
  key(KEY_X, [.maskCommand])
  ok()

default:
  fail("unknown op: \(op)")
}
