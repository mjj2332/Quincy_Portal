## Containment (hard rules)
- Only use tabs you open yourself: `tabs` action `new` with a `label`, and pass that `tabId` on EVERY call. Never omit tabId.
- Only http://localhost:8787 URLs. Never visit any other origin, chrome:// pages, history, passwords or autofill.
- Never pass `focus: true`. Never read, select or close a tab you did not open.
- No sign-in or sign-out. Local dev only. The server is ALREADY RUNNING: do not start, stop or restart any server or process, and run no shell command that starts a long-running process. Do not edit any repository file. Never read `.dev.vars`, `.env*` or `.mcp.json`.
- Restore anything you mutate (listed per pass below) and report it.
- Close every tab and window you opened before your final reply.

## Viewports
- Record `innerWidth`/`innerHeight` (eval) for the desktop tab.
- For 390px: huashu cannot resize the window. Try ONE `eval` `window.open("<url>","qaNarrow","popup,width=390,height=844")` from your tab, then `tabs list` and take ONLY the new tab whose URL is the localhost:8787 URL you just opened. Record its innerWidth. If blocked, put every 390 row under Could not verify with the reason. Close it at the end.

## Input honesty
- huashu `click` with x,y and `key` with `real: true` are trusted browser-level input; `eval`-dispatched events and `el.focus()` are synthetic. Every keyboard, focus and hover row says which kind ran.
- `:focus-visible` needs trusted keyboard input (`key` "Tab" with `real: true`); report `el.matches(':focus-visible')` plus computed outline-style, outline-width, outline-color and box-shadow.
- huashu has no hover tool: a hover row is Could not verify unless you obtained a trusted hover (say how). Never PASS a hover row on synthetic events.

## Focus in a background tab
Your tab is in the background (`document.visibilityState` hidden, `document.hasFocus()` false), and there Chrome matches neither `:focus` nor `:focus-visible`, even after a trusted Tab. For every focus-ring row first report `document.visibilityState`, `document.hasFocus()`, `activeElement.matches(':focus')` and `:focus-visible`. If `:focus` is false, the row is COULD NOT VERIFY (background tab), never FAIL. Do not bring the tab forward. You may report the CSS rule that would apply (from `document.styleSheets`), labelled "rule, not rendered state".

## Screenshots
- `screenshot` with `full: true` and an absolute `savePath` `__EVID__/__PREFIX__-<viewport>-<NN>-<state>.png`; viewport is `desktop` or `390`. Every file in this pass starts with `__PREFIX__-`; never overwrite or reuse an older file.
- One file per state, taken while that state is on screen. Before each screenshot, eval that the state is present (the list is open, the note is visible, the element's rect is inside innerHeight) and report it. Never re-save a state under another name.
- The session opens EVERY saved image. A file showing the wrong state, or byte-identical to another, is deleted and its rows become Could not verify.

## Destructive-action guard (a previous pass hard-deleted a real record)
- Edit and Delete controls on notices and comments act on ONE click or keypress with no confirm. Never Tab or Shift-Tab through them, and never press Enter, Space or End unless you have just eval'd `document.activeElement` (report tag and accessible name) and it is inside the composer/editor or is the exact control the step names.
- Before every coordinate `click`, eval `document.elementFromPoint(x,y)` and report it. Never click an Edit, Delete, Post, Save, Archive or confirm control unless the step names it.
- Unless the pass body says otherwise, edit, post and delete nothing; record the id set of the records on screen at the start and the end (eval) — they must match.

## Report contract (your final reply, markdown)
- Header: loaded bundle vs served bundle, innerWidth/innerHeight per viewport, tab ids used.
- PASS/FAIL table: `# | Check | Expected | Measurement (actual numbers) | Verdict | Screenshot` — the file of the row's OWN state; a DOM-only fact cites the eval output and says so.
- PASS only when your own measurement meets the expectation; a failing number FAILs the row. Token-valued rows report the computed value AND `getComputedStyle(el).getPropertyValue('--token-name')` read on the element itself, and name the exact selector measured.
- "Could not verify": every state or row you could not reach or measure, BY NAME, with the reason. Write "none" only when truly none.
- List every screenshot file saved. Confirm your tabs are closed and every mutation restored.

## This pass
