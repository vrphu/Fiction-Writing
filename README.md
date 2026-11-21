# Fiction Writing

An all-in-one fiction-writing studio for Obsidian — the English edition of the Chinese novel-writing plugin by VRPHU.

**Version 1.0.0**

Everything is stored in plain Markdown inside your vault and processed locally. No cloud, no accounts, no telemetry.

## What's inside

### Catalog — volumes & chapters
- Volume/chapter tree with word counts, drag chapters between volumes
- One-click empty chapter & volume creation, rename volumes (including unfiled chapters)
- Chapter status cycling: Draft → Writing → Needs Revision → Final
- Per-chapter word goals with a floating gradient progress bar (percent, remaining words, live pace)

### Outline
- Typed outline entries (chapter outline, plot, character, worldbuilding… each with its own template)
- Creating an entry generates a same-name Markdown note pre-filled with the template
- Link entries to chapters, lore or other outlines; managed "Linked Items / Notes" sections sync back into the note

### Lore library
- 6 categories: World Bible · Characters · Relationships · Geography & Factions · Power & Rules · Plot & Foreshadowing, plus a Standalone bucket
- Each entry lives at `Lore/<Category>/<Name>.md` with frontmatter metadata (`nws_group` / `nws_type`)
- Body mentions of lore names/aliases get highlighted (colored bold-italic, or bold-italic + underline); hover for a preview card, click to open the note
- Auto-generated **"Appears In"** table at the end of each lore note: appearance counts + clickable chapter links
- Per-entity color control, aliases, metadata editing, and a details view with book-wide stats

### Plot
- Four-stage plot cards (Beginning / Development / Climax / Resolution)
- Link characters and chapter ranges; tags, colors and notes

### Time / Location / Emotion lines
- Multi-track lines: timeline, location line, emotion line — any combination, any number of parallel tracks
- Five views (event / character / plot / location / emotion) change how nodes are named and prompted
- Track-level linking: bind a whole line to a character, place or plot

### Ideas
- Select text in the manuscript → right-click → **Save as idea**, or classify the selection as lore directly
- Optional `[ ]` auto-collect: close a bracket and the content becomes an idea note
- Status workflow: Pending → Adopted / Dropped; each idea is its own note under `Ideas/`

### Annotations
- Select text → right-click → **Add annotation**; the original text is never modified
- Light-yellow shading on the annotated passage, hover to read, manage everything in a table view with jump-back

### Data center
- Words + active writing time on one dual-axis chart (day / week / month)
- Active-time chart, hour-of-day distribution, weekday vs weekend
- KPI cards: writing consistency (streak, missed days, swings), efficiency, goal completion
- Lore usage Top 10, writing heatmap (84 / 365 days), recent file changes, daily word detail

### Pomodoro & Focus Mode
- Pomodoro with configurable focus / short / long breaks, or any custom duration (1–600 min)
- Focus Mode: zen wallpapers (light / night / deep sets), optional dimming, fullscreen
- Procedural ambient sounds (rain, white noise, bubbles…) and typing sounds — Web Audio synthesis, no external files
- Typing mode (current paragraph highlighted, others fade), word milestones (🎯 300 / 600 / 900…)
- Live HUD: typing speed, writing/idle/focus time, words written, completion

### Body typography
- Line height, letter spacing, first-line indent, paragraph gap (reading view), body font size
- Applied uniformly to editing, reading view and focus mode; headings / lists / quotes / code blocks excluded automatically

### Gantt chart (v1.0)
- Schedule chapters or standalone tasks on a timeline with start/end dates, color and a draggable-style progress bar
- Auto-scaling date axis (day / 3-day / week / 2-week ticks) with a Today marker; the axis always covers all tasks
- Each task can optionally bind to a chapter — click the chapter chip to jump to the manuscript
- Filter-free row management: create, edit, reorder and delete tasks; progress is shown as a percentage
- Open with **Studio · Gantt Chart** in the ribbon or the "Open Gantt chart" command

### Release plan (v1.0)
- Track where and when each work is published: title, platform, release date, notes
- Status workflow: Idea → Scheduled → Drafting → Published, changeable inline from a dropdown
- Filter the list by status; sort is by release date
- Each item can optionally bind to a chapter
- Open with **Studio · Release Plan** in the ribbon or the "Open release plan" command

### Story scenes (v1.0)
- Scene cards for beats: title, status (Outline / Draft / Revised / Final), summary, color
- Custom fields shown on every card — defaults are POV, Location, Time, Mood; add or remove your own in Settings → "Story scene custom fields"
- Each scene can optionally bind to a chapter; cards are filterable by status
- Open with **Studio · Story Scenes** in the ribbon or the "Open story scenes" command

### Writing scenes (presets)
- A preset bundles wallpaper, ambient sound, typing sound, focus behavior (dimming / fullscreen / typing mode) and all typography settings
- Three built-in presets: Midnight Novelist, Morning Draft, Cafe Write
- Apply a preset to restore the entire writing atmosphere in one click; save the current setup as a new preset, or rename/delete presets
- Manage from **Studio · Writing Scenes** in the ribbon, the "Writing scenes (presets & quick switch)" command, or Settings → "Writing scene presets"

## Folder layout (defaults, configurable in settings)

```
Vault/
├── Manuscript/     (chapters — only md files here count as chapters & stats)
├── Outline/        (one note per outline entry)
├── Lore/           (Lore/<Category>/<Name>.md)
└── Ideas/          (one note per idea)
```

## Usage tips

- Open any panel from the ribbon or the command palette ("Studio · …").
- Right-click selected text in the manuscript for the quick actions: save as idea, save as lore, add annotation, change highlight color.
- Single-click a highlighted lore word to open its note (toggle in settings; Ctrl/Cmd+click always works).
- The chapter stats popup (📊 on any chapter row) shows goal, pace, focus, lore categories and the chapter's Top 10.

## Credits

- Original Chinese plugin and design: **Novel Writing** by VRPHU
- English edition: full translation of UI, templates, settings and code comments, with the `[ ]` idea-collection brackets adapted for English keyboards
- v1.0.0: added Gantt chart, release plan, story scene cards and writing-scene presets (all UI in English)
