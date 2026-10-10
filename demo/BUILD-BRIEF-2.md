# Hearth demo — build brief, phase 2: Drive, Docs editor, Sheets, Slides

The owner asked for:
- creating docs in the demo;
- a Docs section that works "kind of like a Google Drive";
- Slides and Sheets.

Four areas build this in parallel. Each owns only its files.

## Common instructions

Everything under "Common instructions" in `demo/BUILD-BRIEF.md` still applies:
- the product context and the shell facts;
- the hard rules on tokens, copy, accessibility and AI marking;
- the verify loop (tsc, vite build, screenshots you actually look at).

Read that section first. This brief changes or adds the following.

**New shared code (read it, use it, don't reinvent it):**
- `src/types.ts` → the "Drive (FILE-01..08)" section: `DriveMeta`, `Editable`, `Doc`, `Folder`, `DriveUpload`, `SheetCell`, `SheetTab`, `Sheet`, `Slide`, `Deck`, `DocTemplateId`. Routes:
  - `{ name: 'drive', view?, folderId? }`
  - `{ name: 'docs', docId? }` (without a docId it renders the Drive)
  - `{ name: 'sheets', sheetId }`
  - `{ name: 'slides', deckId }`
  - `{ name: 'file', fileId }`
  
  `SourceRef.kind` now also takes `'sheet' | 'slides' | 'file'`.
- `src/store.tsx` → new state: `folders`, `uploads`, `sheets`, `decks` (docs also includes Ashton's `d_board`). New API:
  - `createDoc({ folderId?, template?, title?, open? })`, `createSheet({ folderId?, title?, tabs?, open? })`, `createDeck({ folderId?, title?, slides?, open? })` — each returns the new id and opens it unless `open: false`;
  - `createFolder(title, parentId)`, `addUpload(file)`;
  - `patchItem(id, patch)`, `renameItem(id, title)`;
  - `moveItem(id, folderId)` (returns false if a folder would land inside itself);
  - `toggleStar(id)`, `trashItem(id)`, `restoreItem(id)`, `deleteForever(id)`;
  - `openItem(id)` (opens anything and marks it recently opened);
  - `updateSheet(sheet)`, `updateDeck(deck)`, and the existing `updateDoc(doc)`.
- `src/drive.ts` → `driveEntries`, `findEntry`, `routeFor`, `kindLabel`, `folderPath`, `teamFolderOf`, `isTrashed`, `accessOf`, `canEdit`, `isSharedWithMe`, `isInMyDrive`, `ownerLabel`.
- `src/data/drive.ts` → seed folders, uploads, sheets (`sh_ot`, `sh_forecast`, `sh_movers`), decks (`dk_q4`, `dk_allhands`), `docTemplates`, `myDocs`. Seed docs are in `src/data/work.ts` and now have `folderId`.
- `src/ui/share.tsx` → `<ShareDialog itemId open onClose />`.
  - **Every** editor's "Share" button opens this component. Don't build your own.
  - The **drive** area replaces its body. The props stay exactly as they are.
- The shell (`src/App.tsx`):
  - "Docs" is now "Drive" in the nav.
  - `docs` with a docId, `sheets`, `slides` and `file` are immersive on phones (no top bar or tabs, so render your own header with a back button).
  - These routes all highlight Drive in the nav.

**Where you work (local workflow agents):**
- Make your own git worktree off the commit you're given:
  `git -C /home/user/mainsoftware worktree add <scratchpad>/wt-<area> -b demo-<area> <commit>`
- Symlink node_modules into it:
  `ln -s /home/user/mainsoftware/demo/node_modules <scratchpad>/wt-<area>/demo/node_modules`
- Do all work and all builds there, and commit to branch `demo-<area>`.
- Never edit, check out or build in `/home/user/mainsoftware` itself, and never push.

Cloud sessions work on their own branch as told, and push it. **Do not open a pull request.**

**Commit message trailer (every commit):**
```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WSjv5jrH1ruCkFeB1R6TXi
```

**Shared files:**
- You may make *small, essential* edits outside your own files, for example one optional field in `types.ts`.
- List each one in your final report with file:line and why.
- Prefer keeping helpers inside your own files.

**Artifact limits** (the demo ships as one HTML page in a sandboxed viewer):
- No `alert`/`confirm`/`prompt`; build confirmations into the page.
- No `window.open` and no download links; downloads show an honest toast, or use "Copy …" to the clipboard (`navigator.clipboard.writeText` inside the click handler, catching rejection).
- No print.
- File inputs, drag-and-drop of files, `FileReader`, `URL.createObjectURL`, the `paste`/`copy` events, and fullscreen requested from a click (treat it as optional) all work.

**AI rules (PRD §7, D16):**
- AI writing help only *suggests*: the person sees a preview and chooses Insert/Accept or Discard.
- It shows `<AIMarker/>` and source chips to what it was based on.
- It only uses things the user can open. Compute suggestions from the real demo data where you can, instead of canned text.

**Quality bar:** this is a demo people will click through on a phone.
- Every visible control does something sensible, or is clearly labelled as not in the demo.
- No dead ends.
- Empty states say what goes there and how to add the first item.
- Edits persist while the page is open: navigate away and back, and they're still there.

**Verify** at phone (390) and desktop (1440), in light and dark, for every state below. Drive real interactions with Playwright where clicking matters. `scripts/screenshots.mjs` accepts `--before`/`--after` JS, where `h` is `window.__hearth`; wrap any awaits in an async IIFE.

---

## Area: drive

**Files you own:**
- `src/screens/Drive.tsx`
- `src/screens/drive/*` (new)
- `src/screens/FilePreview.tsx`
- `src/ui/share.tsx` (replace the body; keep the props)
- `src/screens/ask/search.ts` and the file-result parts of `src/screens/Ask.tsx` (to index the new kinds)

**PRD:** §8.7 FILE-01..08, DOC-03, D19, §7 Rules 1–3 (AI mirrors access).

**Spec:**
- **Layout, desktop:**
  - A Drive sidebar inside the screen, holding:
    - a big "New" button;
    - Home, My Drive, Shared with me, Recent, Starred and Trash;
    - a "Team folders" list (folders with `team`, with a colour dot);
    - a storage meter, e.g. "3.2 GB of 30 GB used", FILE-07.
  - The main panel has:
    - a header with a breadcrumb (`folderPath`);
    - a search field that filters this Drive by name and extracted text;
    - a list/grid toggle;
    - sort (Name, Last modified, Owner);
    - type filter chips (Folders, Docs, Sheets, Slides, PDFs, Images, Videos).
- **Layout, phone:**
  - a title and search;
  - a segmented control or chips for the views;
  - a floating "New" button, kept clear of the tab bar;
  - folders open in place, with a back control and a compact breadcrumb.
- **Views:**
  - **Home** (default `{name:'drive'}`):
    - "Suggested": the 4 most recently opened items, as cards with thumbnails;
    - Team folders;
    - Recent files.
  - **My Drive** (`isInMyDrive`, root level): folders first, then files.
  - **Shared with me** (`isSharedWithMe`): shows who shared each item, and "Shared in #ops-north-site" for `fromConversationId` (FILE-08).
  - **Recent** (by `lastOpenedAt`, then `updatedAt`).
  - **Starred.**
  - **Trash:**
    - shows top-level trashed items;
    - Restore;
    - "Delete forever" with an in-page confirm;
    - a note that items are deleted after 30 days.
  - **Inside a folder:** its children, with the folder's details: team, description and who can open it.
- **Rows and cards:**
  - **Icon tile per kind, all from tokens:**
    - doc: accent;
    - sheet: ok;
    - slides: warn;
    - pdf: rec;
    - image and video: agent;
    - folder: surface-2, with its colour dot.
  - **Name, owner and modified:** owner shows as "me" or a name; modified reads e.g. "Fri 7:20 pm · Marcus".
  - **Extra details:**
    - size for uploads;
    - a shared indicator when access isn't restricted or there are named people;
    - a star toggle;
    - a "More" menu.
  - **Grid thumbnails show real content:**
    - doc: the first lines of text;
    - sheet: a mini grid of the first cells;
    - slides: the first slide's title on its theme colours;
    - image: a gradient from `hue`, or the blob URL;
    - pdf: a paper page with the start of `previewText`.
- **"More" menu** (a Sheet on phones, a popover on desktop):
  - Open; Rename (an inline dialog); Star or Unstar; Share (the `ShareDialog`).
  - Move to…: a folder picker you can navigate. Block moving a folder into itself, and show why.
  - Make a copy: docs, sheets and decks, using `create*` with `open:false`, named "Copy of …".
  - Download: an honest toast.
  - Move to trash: only if you own it or can edit it; otherwise disabled, with the reason.
- **"New" menu:**
  - New folder (a name dialog).
  - Doc, which opens a template picker built from `docTemplates`, then `createDoc` in the current folder.
  - Sheet; Slides.
  - Upload files: a real `<input type=file multiple>`.
    - Detect the kind from the MIME type.
    - Store a formatted size.
    - Use `URL.createObjectURL` for image, video and audio previews.
    - For text files, read the first 2,000 characters with `FileReader` into `previewText`, so they become searchable (FILE-06).
    - Toast: "Uploaded 2 files to Q4 launch".
  - Phone: also "Photo or video", using `accept="image/*,video/*"`.
  - Desktop: drag-and-drop onto the main panel, with a drop highlight.
- **ShareDialog** (`src/ui/share.tsx`), FILE-03 and DOC-03:
  - **People with access:** owner, editors and `sharedWith`, each with a role select (Viewer, Commenter, Editor) and Remove. Editors go in `editors` for editable kinds; other roles go in `sharedWith`.
  - **Add people:** search humans and pick a role.
  - **General access:** Restricted / the team (from the team folder, or the owner's team) / Everyone at Tembusu Logistics.
  - **Copy link:** use `https://hearth.tembusu.example/d/<id>`, with a clipboard fallback.
  - **The access rule:** a line saying "Search and the assistant only show this to people who can open it."
  - **Read-only rule:** if you can't edit the item, the dialog is read-only and says who can change it.
- **FilePreview** (route `file`):
  - Full screen, with a header: back, title, star, Share and a "More" menu.
  - **Body by kind:**
    - image: the blob URL or generated art;
    - pdf: stacked "paper" pages showing `previewText` and "Page 1 of N";
    - video: a poster with a play button, or a real `<video>` for blob URLs;
    - other kinds: "No preview for this file type".
  - **Details panel:**
    - type, size, owner, modified;
    - location, with a link to the folder;
    - who has access;
    - "Shared in #channel" (FILE-08);
    - "Text in this file is searchable by people who can open it" (FILE-06);
    - versions (FILE-05): "Upload a new version" via a file input, which adds a version row and bumps `updatedAt`.
- **Search integration:**
  - Extend `src/screens/ask/search.ts`, and the Ask screen's result groups, to include the new kinds:
    - folders: by title;
    - sheets: title and cell values;
    - decks: slide text;
    - uploads: title and `previewText`.
  - Group them under Docs, renamed "Files" if that reads better.
  - Each result opens via `routeFor`.
  - Keep everything that works today working.
- **Screenshots to verify:**
  - Home, My Drive, Shared with me, the Q4 launch folder, Trash (after trashing something), and grid view;
  - the "New" menu, the template picker and the Share dialog;
  - previews of `up_ot`, `up_layout` and `up_safety`;
  - Ask results for "kranji".
  - Also run the flow: create a folder, create a doc inside it, go back, and see it listed.

---

## Area: docs

**Files you own:**
- `src/screens/Docs.tsx`
- `src/screens/docs/*` (new)

**PRD:** §8.6 DOC-01..11, D16, D19.

**Spec:**
- **Remove** the old `DocsHome`; the Drive replaces it.
- **Header:**
  - back;
  - an editable title for editors, otherwise plain text;
  - a breadcrumb "Drive › Q4 launch" that opens the folder;
  - star;
  - presence;
  - a save state: "Saving…" then "Saved to Drive";
  - Share, which opens `ShareDialog`;
  - a "More" menu with Make a copy, Version history, "Copy as Markdown" (to the clipboard; DOC-11 is honest about what the demo can do), Move to trash and Details.
- **Editing, like Google Docs (DOC-01):**
  - Editors get a mode switch: Editing / Viewing. New docs open in Editing, with the cursor in the first empty block.
  - **Every block is editable.** Use plain-text `contentEditable` or auto-growing textareas, and keep the caret stable.
  - **Keyboard:**
    - Enter splits or creates the next block. Lists and checklists continue, and Enter on an empty item turns it back into text.
    - Backspace at the start merges into the previous block, and an empty block deletes.
    - Arrow up and down move between blocks.
  - **Block types:** a toolbar for Text, Heading 1, Heading 2, Bulleted list, Checklist and Quote. Also:
    - "/" on an empty block opens the same menu;
    - Markdown shortcuts: `# `, `## `, `- `, `[] `, `> `.
  - **Checkboxes** toggle.
  - **Phone:** a compact block-type bar pinned to the bottom of the editor.
  - **Saving:** debounce `updateDoc` with `updatedAt`/`updatedBy` set to ME.
  - **Version history:** when you leave a doc you edited, add one `DocVersion`, "You edited", with `added`/`removed` line diffs (DOC-04), so it shows up in history.
- **Viewing mode:** keep what works today:
  - anchored comments with highlights (DOC-05);
  - live cursor and presence;
  - the permissions line (DOC-03);
  - version history with diffs and restore;
  - the AI draft for `d_q4`.
- **Non-editors:**
  - Read-only, with a line: "View only · Priya and you can edit".
  - A "Request edit access" button that shows an honest toast.
- **Empty or new docs:**
  - **Template chips** when the doc is blank: Meeting notes, Project brief, Policy page and Onboarding guide, from `docTemplates`. Picking one replaces the blank body.
  - **Help me write** (DOC-09, suggest-only), with the result shown as a preview card with Insert or Discard, `<AIMarker/>` and sources:
    - **"Draft from a meeting":** pick one of the sessions in `state.sessions` that has notes. Build blocks from `session.notes`: a summary paragraph, "Decisions" (list), "Action items" (checklist, including owner names) and "Open questions". Source: the session.
    - **"Summarise this doc"**, for any doc with text: an extractive summary, i.e. the first sentence of each section, as a quote block at the top. Source: the doc.
- **Screenshots to verify:**
  - New-doc flow: `h.createDoc()` → type a title and three blocks (one checklist) → leave → reopen, and the edits are still there with a history entry.
  - A template doc.
  - A doc made with Draft from a meeting.
  - `d_q4` in viewing mode: comments, history and the AI draft still work.
  - `d_leave` as a non-editor.
  - Phone and desktop, light and dark.

---

## Area: sheets

**Files you own:**
- `src/screens/Sheets.tsx`
- `src/screens/sheets/*` (new)

The formula engine goes in `sheets/formula.ts`, kept pure, with its own tests.

**PRD:** DOC-12 (brought into the demo by the owner), DOC-03, D16.

**Spec:**
- **Header:**
  - back;
  - an editable title;
  - a breadcrumb to the folder;
  - star;
  - presence avatars;
  - a save state;
  - Share (`ShareDialog`);
  - a "More" menu with Make a copy, "Copy as CSV" (clipboard) and Move to trash.
- **Toolbar** (editors):
  - undo/redo;
  - bold, italic, align;
  - number format: Automatic, Number, Currency (S$), Percent, Plain text;
  - fill colour, using token fills;
  - Σ, which inserts SUM, AVERAGE, MIN, MAX or COUNT for the selection or the column above.
- **Formula bar:** the active cell address and the raw value, editable.
- **Grid:**
  - Column letters and row numbers, sticky while scrolling, with `frozenRows` honoured.
  - Click to select; shift-click or drag selects a range.
  - **Keyboard:**
    - arrows, Tab and Shift-Tab, Enter and Shift-Enter move the selection;
    - typing starts an edit, and F2 or double-click edits in place;
    - Escape cancels, and Delete or Backspace clears.
  - **Clipboard:** copy and paste ranges as TSV through the copy/paste events.
  - **Size:** use column widths from `colWidths`, with drag-to-resize on desktop, and an "Add 20 rows" control at the end.
  - **Status bar for a range:** Sum, Average and Count.
- **Tabs bar:** switch tabs, add a tab, rename it (double-click) and delete it (with an in-page confirm).
- **Formula engine** (pure, recalculated on change):
  - **Values:** numbers, strings in quotes, booleans.
  - **Operators:** `+ - * / ^ &`, unary minus, parentheses, and comparisons `= <> < > <= >=`.
  - **References:** `A1`, `$A$1` and ranges `A1:C9`.
  - **Functions:** SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, ROUND, ABS, IF, AND, OR, CONCAT.
  - **Errors:** `#DIV/0!`, `#REF!`, `#NAME?`, `#VALUE!` and `#CYCLE!` for circular references.
  - **Display formats:**
    - currency: `S$1,234.00`;
    - percent: one decimal, e.g. `96.0%`;
    - integer: thousands separators;
    - number: up to 2 decimals.
  - **Tests:** a small test file run with `node --experimental-strip-types`, covering the seed sheets' expected values. For example, the `sh_ot` total OT pay must equal the hand-computed sum.
- **Presence:** draw collaborators' `cursors` as coloured cell outlines with a name tag. You may move one occasionally to feel live.
- **Ask about this sheet** (suggest-only, computed from the data):
  - **A panel with suggested questions,** chosen per sheet. For example:
    - forecast: "Which weeks go over capacity?";
    - OT roster: "What is the total OT pay and is it within budget?";
    - movers sheet: "How much do we save with Kranji?"
  - **Free text** for questions you can answer by computing.
  - **Answers** come with cell-reference chips that select the cells, plus `<AIMarker/>`.
  - **"Suggest a formula"** for an empty cell under a numeric column, with Accept.
- **Non-editors:** read-only, with a line saying who can edit.
- **Phone:**
  - The grid scrolls inside its own container in both directions, with sticky headers.
  - Row height is at least 36px.
  - Tap selects; tap again, or the formula bar, edits.
  - A compact toolbar.
  - No page-level horizontal scroll.
- **New sheet:** a blank 50×12 grid with the title focused, then A1.
- **Screenshots to verify:**
  - all three seed sheets (`sh_forecast` shows week 8 over capacity in amber);
  - typing a formula, and a range selection with the status bar;
  - a `#CYCLE!` case;
  - the Ask panel;
  - a new sheet;
  - phone and desktop, light and dark.

---

## Area: slides

**Files you own:**
- `src/screens/Slides.tsx`
- `src/screens/slides/*` (new)

You may add an optional `imageUrl?: string` to `Slide` in `src/types.ts`.

**PRD:** DOC-13 (brought into the demo by the owner), DOC-03, D16.

**Spec:**
- **One slide renderer** used by the canvas, the thumbnails and present mode:
  - a fixed 16:9 design size (e.g. 1280×720), scaled to fit;
  - layouts: `title`, `section`, `bullets`, `two-column`, `big-number`, `quote` and `image`;
  - themes `ember` (warm light), `slate` (dark) and `teal`. Their colours are slide content, so they look the same in app light and dark mode, and every theme must be readable.
- **Editor, desktop:**
  - **Header:** back, editable title, breadcrumb, star, presence, save state, Share (`ShareDialog`) and a primary "Present" button.
  - **Left:** a filmstrip of numbered thumbnails, with the selected one highlighted, and "+ Add slide" offering a layout picker.
  - **Centre:**
    - the canvas, where you edit text directly on the slide;
    - bullets: Enter adds one, and Backspace on an empty bullet removes it;
    - big-number: edit the stat and its label;
    - two-column: edit the headings and both lists;
    - quote: edit the text and the attribution;
    - image: replace the image through a file input and a blob URL.
  - **Under the canvas:** speaker notes.
  - **Toolbar:** Layout, Theme (whole deck), Duplicate, Delete (in-page confirm), Move up and Move down. Alt+↑/↓ also reorders.
- **Phone:**
  - the canvas at full width;
  - a horizontal filmstrip under it;
  - a compact toolbar;
  - notes collapsible;
  - editing works with taps.
- **Present mode:**
  - a full-viewport overlay, with fullscreen requested from the click (optional, catch rejection);
  - keys ←/→, Space, PageUp/PageDown and Escape; tap the right or left half; swipe on phones;
  - a slide counter;
  - N toggles speaker notes;
  - respect the safe areas.
- **AI** (suggest-only, computed from the data):
  - **"Draft slides from a doc":**
    - pick a doc you can open;
    - build a title slide from its h1, and a bullets slide per h2 from the li, todo and p lines under it (shortened);
    - turn any line with a big number into a big-number slide;
    - show a preview strip with "Add N slides" or Discard;
    - add a source chip to the doc.
  - **"Write speaker notes"** for the current slide, built from its text, with Accept.
- **New deck:** one title slide with the title focused. Also show an empty-state offer: "Start from a doc", or pick a layout.
- **Non-editors:** view and present only.
- **Screenshots to verify:**
  - `dk_q4` editor (desktop and phone);
  - `dk_allhands` in teal;
  - present mode on slides 1 and 3;
  - adding a two-column slide and editing it;
  - a deck drafted from `d_q4`;
  - light and dark.
