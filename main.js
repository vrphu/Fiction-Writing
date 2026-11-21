'use strict';

const obsidian = require('obsidian');
const {
  Plugin, ItemView, Modal, Notice, Setting, PluginSettingTab,
  TFile, TFolder, normalizePath, MarkdownView
} = obsidian;

/* ===== v3.0 root-cause fix: loading the CM6 decoration APIs =====
   Obsidian's require('obsidian') export object does NOT include Decoration/ViewPlugin/RangeSetBuilder
   (verified against the __export table in obsidian.asar). Older versions tested on it and set HAS_CM=false,
   so the entire body decoration layer (lore highlight / quote highlight / annotations / milestones / typing mode)
   never registered — that is the real reason highlighting "could not be configured and never showed up".
   Correct approach: grab the internal @codemirror modules via the require that Obsidian intercepts. */
let Decoration = null, ViewPlugin = null, RangeSetBuilder = null;
const cmLoadErrors = [];
try {
  const cmView = require('@codemirror/view');
  Decoration = cmView.Decoration;
  ViewPlugin = cmView.ViewPlugin;
  if (cmView.EditorView) globalThis.__NWS_EditorView = cmView.EditorView;
} catch (e) { cmLoadErrors.push('@codemirror/view: ' + (e && e.message || e)); }
try {
  const cmState = require('@codemirror/state');
  RangeSetBuilder = cmState.RangeSetBuilder;
} catch (e) { cmLoadErrors.push('@codemirror/state: ' + (e && e.message || e)); }
/* Fallback: on some old/custom Obsidian builds that don't expose internal modules, try the official objects (unlikely to exist) */
if (!ViewPlugin && obsidian.ViewPlugin) ViewPlugin = obsidian.ViewPlugin;
if (!Decoration && obsidian.Decoration) Decoration = obsidian.Decoration;
if (!RangeSetBuilder && obsidian.RangeSetBuilder) RangeSetBuilder = obsidian.RangeSetBuilder;
/* ViewPlugin.fromClass requires Decoration.set to be available; register only when all three exist */
const HAS_CM = !!(Decoration && ViewPlugin && Decoration.set && ViewPlugin.fromClass);

/* ---------- Constants ---------- */
const VIEW_CATALOG = 'nws-catalog';
const VIEW_OUTLINE = 'nws-outline';
const VIEW_ENTITIES = 'nws-entities';
const VIEW_NOTES = 'nws-notes';
const VIEW_PLOTS = 'nws-plots';       // Plot
const VIEW_LINES = 'nws-lines';       // Time-location dual lines
const VIEW_STATS = 'nws-stats';       // Data center (heatmap / word stats)
const VIEW_ANNOT = 'nws-annot';       // v2.7 annotation manager

/* Four plot stages */
const PLOT_STAGES = [
  { key: 'begin', label: 'Beginning', emoji: '🌱' },
  { key: 'develop', label: 'Development', emoji: '🌿' },
  { key: 'climax', label: 'Climax', emoji: '🔥' },
  { key: 'end', label: 'Resolution', emoji: '🏁' }
];
/* Lore types a dual-line node can link (libraries + plots + custom) */
const LINE_BIND_KINDS = ['Character', 'Character Relationships', 'Geography', 'Power System', 'Items & Artifacts', 'Society & Culture', 'Economy & Technology', 'Storyline', 'Scene', 'Conflict', 'Foreshadowing', 'Timeline', 'Clue', 'Information Gap', 'Emotion', 'Plot'];
/* ===== v2.4: multi-track time/location/emotion lines =====
   track = { id, name, axis:'time'|'space'|'emotion', view, bindings, order, created }
   A track can be renamed (e.g. 'A character's action trail', 'Royal capital geography line', 'Protagonist emotion curve') and linked to characters/lore/plots as a whole.
   The three axes combine freely: show only time / only location / only emotion / any number of parallel tracks.
   Node node.trackId points to track.id (legacy nodes with line:'time'|'space' migrate to the default track).
   The view decides node naming and content hints. */
const TRACK_AXES = [
  { key: 'time', name: 'Timeline', emoji: '⏳' },
  { key: 'space', name: 'Location Line', emoji: '🗺️' },
  { key: 'emotion', name: 'Emotion Line', emoji: '💗' }
];
/* Views: available for time/location/emotion; the emotion view has a dedicated trigger-source field */
const TRACK_VIEWS = [
  { key: 'event', name: 'Event View', emoji: '📌', node: 'Event', at: 'Time Scale', hint: 'Link standalone events in time / order' },
  { key: 'person', name: 'Character View', emoji: '👤', node: 'Experience Node', at: 'Time / Age', hint: 'Follow one character\'s experiences' },
  { key: 'plot', name: 'Plot View', emoji: '🧩', node: 'Plot Node', at: 'Chapter / Act', hint: 'Follow plot progression' },
  { key: 'space', name: 'Location View', emoji: '🗺️', node: 'Location Node', at: 'Position / Coordinates', hint: 'Follow places and scene changes' },
  { key: 'emotion', name: 'Emotion View', emoji: '💗', node: 'Emotion Node', at: 'Trigger (event / place / time period / external condition)', hint: 'Record emotional shifts; link triggers to events / places / characters / conditions, describe intensity in content' }
];
/* Rename suggestions: ready-to-use line name templates by axis + view */
const TRACK_NAME_PRESETS = {
  time: ['Protagonist growth timeline', 'Story progression timeline', 'A character\'s action trail', 'Dual Lines · Time'],
  space: ['Royal capital geography line', 'Protagonist\'s route', 'Scene-change location line', 'Dual Lines · Location'],
  emotion: ['Protagonist emotion curve', 'Emotional shifts caused by events', 'Mood atmosphere line of a place', 'Reader tension curve']
};
function trackAxisDef(k) { return TRACK_AXES.find((a) => a.key === k) || TRACK_AXES[0]; }
function trackViewDef(k) { return TRACK_VIEWS.find((v) => v.key === k) || TRACK_VIEWS[0]; }

const PALETTE = ['#C98B86', '#8FAF95', '#86A0BD', '#D2A271', '#D4BE76', '#A797BE'];
const PALETTE_NAMES = ['Red', 'Green', 'Blue', 'Orange', 'Yellow', 'Purple'];
/* v2.2: most-used classifications at context-menu top level (most clicked), laid flat instead of nested submenus */
const QUICK_CLASSIFY = [
  { type: 'Foreshadowing', group: 'Plot & Foreshadowing', emoji: '🔖' },
  { type: 'Plot', group: 'Plot & Foreshadowing', emoji: '🧩' },
  { type: 'Character', group: 'Characters', emoji: '👤' },
  { type: 'Geography', group: 'Geography & Factions', emoji: '🗺️' },
  { type: 'Character Relationships', group: 'Relationships', emoji: '🔗' },
  { type: 'Clue', group: 'Plot & Foreshadowing', emoji: '🔎' },
  { type: 'Power System', group: 'Power & Rules', emoji: '⚡' },
  { type: 'Themes', group: 'World Bible', emoji: '🎭' },
];

/* ===== v2.0: two-level lore library system (category → library) =====
   Category (group) = the 6 user-facing categories + Themes + Writing Style; anything unclassifiable falls into "Standalone".
   Library (lib/type) = a concrete lore type; each entry is still Lore/<Name>.md with type written to frontmatter.
   fields builds the template body skeleton (## fields); every category and library has its own template. */
const ENTITY_GROUPS = [
  { name: 'World Bible', emoji: '🌍', color: 1, fields: ['Era & Background', 'Origin of the World', 'Core Conflict', 'Laws of the World', 'Social Structure', 'Tech / Power Level', 'Geography Overview', 'Culture & Beliefs'], libs: ['Worldbuilding', 'Society & Culture', 'Economy & Technology', 'Themes'] },
  { name: 'Characters', emoji: '👤', color: 2, fields: ['Role in Story', 'Name / Title', 'Appearance', 'Personality', 'Abilities / Skills', 'Background', 'Motivation & Goals', 'Relationships', 'Appears In'], libs: ['Character'] },
  { name: 'Relationships', emoji: '🔗', color: 5, fields: ['Party A', 'Party B', 'Relationship Type', 'How It Started', 'Evolution', 'Key Events', 'Current Status', 'Related Chapters'], libs: ['Character Relationships'] },
  { name: 'Geography & Factions', emoji: '🗺️', color: 1, fields: ['Location', 'Type', 'Climate / Terrain', 'Key Places', 'Faction', 'Historical Events', 'Related Characters', 'Related Chapters'], libs: ['Geography', 'Scene', 'Faction'] },
  { name: 'Power & Rules', emoji: '⚡', color: 3, fields: ['System / Rule Name', 'Source', 'Levels / Clauses', 'Core Content', 'Costs & Limits', 'Exceptions', 'Key Figures', 'Related Plots'], libs: ['Power System', 'Items & Artifacts', 'Rules'] },
  { name: 'Plot & Foreshadowing', emoji: '🧩', color: 3, fields: ['Type (main / side)', 'One-line Summary', 'Beginning', 'Development', 'Climax', 'Resolution', 'Foreshadowing / Clues', 'Related Characters', 'Related Chapters'], libs: ['Storyline', 'Plot', 'Foreshadowing', 'Conflict', 'Timeline', 'Clue', 'Information Gap', 'Emotion'] },
  { name: 'Standalone', emoji: '📌', color: 0, fields: ['Description', 'Key Points', 'Related Lore', 'Related Chapters'], libs: ['Writing Style', 'Custom'] },
];
const GROUP_BY_NAME = Object.create(null);
ENTITY_GROUPS.forEach((g) => { GROUP_BY_NAME[g.name] = g; });
/* Library → category mapping */
const LIB_GROUP = Object.create(null);
ENTITY_GROUPS.forEach((g) => g.libs.forEach((l) => { LIB_GROUP[l] = g.name; }));
function groupOfLib(lib) { return LIB_GROUP[lib] || 'Standalone'; }
function libsOfGroup(group) { const g = GROUP_BY_NAME[group]; return g ? g.libs.slice() : ['Custom']; }
function groupEmoji(group) { return (GROUP_BY_NAME[group] || {}).emoji || '📌'; }
/* v2.11: category → subfolder name (the "Geography & Factions" category contains a slash; replace with a middle dot so it doesn't become nested folders) */
function groupFolderName(group) {
  return String(group || 'Standalone').replace(/[\\/:*?"<>|]/g, '·').trim() || 'Standalone';
}
/* v2.11: the category folder a lore entry belongs in (Lore/<Category>/); the category is determined by frontmatter nws_group */
function groupFolderOf(e) { return groupFolderName((e && e.group) || groupOfLib((e && e.type) || 'Character') || 'Standalone'); }
function groupFields(group) { const g = GROUP_BY_NAME[group] || GROUP_BY_NAME['Standalone']; return g.fields; }

/* Library definitions (with template fields). All legacy library names kept for data compatibility, plus new libraries for the big categories. */
const LIBRARIES = [
  { name: 'Character', emoji: '👤', color: 2, fields: ['Role', 'Gender', 'Age', 'Appearance', 'Personality', 'Abilities / Skills', 'Background', 'Motivation & Goals', 'Relationships', 'Appears In'] },
  { name: 'Character Relationships', emoji: '🔗', color: 5, fields: ['Party A', 'Party B', 'Relationship Type', 'How It Started', 'Evolution', 'Key Events', 'Current Status', 'Related Chapters'] },
  { name: 'Geography', emoji: '🗺️', color: 1, fields: ['Location', 'Type', 'Climate', 'Terrain', 'Key Places', 'Faction', 'Historical Events', 'Related Characters'] },
  { name: 'Power System', emoji: '⚡', color: 3, fields: ['System Name', 'Power Source', 'Rank Tiers', 'Core Rules', 'Costs & Limits', 'Key Figures', 'Related Plots'] },
  { name: 'Items & Artifacts', emoji: '🗡️', color: 3, fields: ['Category', 'Look', 'Function / Effect', 'Rarity', 'Origin', 'Restrictions', 'Owner', 'Related Chapters'] },
  { name: 'Society & Culture', emoji: '🏛️', color: 1, fields: ['Region', 'Organization / Clan', 'Structure', 'Customs & Etiquette', 'Beliefs', 'Language', 'Related Conflicts'] },
  { name: 'Economy & Technology', emoji: '⚙️', color: 4, fields: ['Economy', 'Core Technology', 'Key Resources', 'Trade', 'Tech Level', 'Social Impact', 'Related Lore'] },
  { name: 'Storyline', emoji: '🧩', color: 3, fields: ['Type (main / side)', 'Summary', 'Cause', 'Turning Point', 'Climax', 'Resolution', 'Related Characters', 'Related Chapters'] },
  { name: 'Scene', emoji: '🏞️', color: 1, fields: ['Place', 'Time', 'Characters Involved', 'Atmosphere', 'What Happens', 'Connections', 'Related Chapters'] },
  { name: 'Conflict', emoji: '⚔️', color: 0, fields: ['Parties in Conflict', 'Cause', 'Escalation', 'Key Turn', 'Resolution', 'Consequences', 'Related Characters', 'Related Chapters'] },
  { name: 'Foreshadowing', emoji: '🔖', color: 0, fields: ['Foreshadowing Text', 'Where Planted', 'Where Revealed', 'Related Characters', 'Related Plots', 'Reader Hint'] },
  { name: 'Timeline', emoji: '⏳', color: 5, fields: ['Point in Time', 'Event', 'Parties Involved', 'Place', 'Cause & Effect', 'Related Chapters'] },
  { name: 'Clue', emoji: '🔎', color: 4, fields: ['Clue Text', 'Where Found', 'Points To', 'Related Characters', 'Related Foreshadowing', 'Related Chapters'] },
  { name: 'Information Gap', emoji: '💡', color: 5, fields: ['Who Knows', 'Who Doesn\'t Know', 'Information', 'How It Formed', 'How It\'s Used', 'Related Storylines'] },
  { name: 'Emotion', emoji: '💗', color: 5, fields: ['Who Feels It', 'Trigger / Emotional Peak', 'Triggering Event', 'Trigger Place', 'Trigger Time Period', 'External Condition', 'Emotional Shift', 'Outward Signs', 'Related Characters', 'Related Chapters'] },
  { name: 'Worldbuilding', emoji: '🌍', color: 1, fields: ['Era & Background', 'Origin of the World', 'Core Conflict', 'Laws of the World', 'Social Structure', 'Tech / Power Level', 'Geography Overview', 'Culture & Beliefs'] },
  { name: 'Faction', emoji: '🏯', color: 1, fields: ['Faction Name', 'Faction Type', 'Seat of Power', 'Leader / Core', 'Members', 'Faction Goals', 'Relations with Other Factions', 'Related Characters', 'Related Chapters'] },
  { name: 'Rules', emoji: '📜', color: 3, fields: ['Rule Name', 'Scope', 'Core Clauses', 'Penalty for Violation', 'Exceptions', 'Author', 'Related Lore', 'Related Chapters'] },
  { name: 'Themes', emoji: '🎭', color: 5, fields: ['Theme Name', 'Statement', 'Carried by Whom', 'Shown in Which Plot', 'Symbolic Imagery', 'Recurring Elements', 'Reader Takeaway', 'Related Chapters'] },
  { name: 'Writing Style', emoji: '✒️', color: 4, fields: ['Narrative Person', 'Narrative POV', 'Tone', 'Sentence Style', 'Word Choice', 'Dialogue Style', 'Rhetoric Preferences', 'Avoid', 'Reference Example'] },
  { name: 'Custom', emoji: '🖋️', color: 0, fields: ['Type', 'Description', 'Key Points', 'Related Lore', 'Related Chapters'] },
];
const LIB_BY_NAME = Object.create(null);
LIBRARIES.forEach((l) => { LIB_BY_NAME[l.name] = l; });
const DEFAULT_ENTITY_TYPES = LIBRARIES.map((l) => l.name);
const DEFAULT_ENTITY_TYPE_COLOR = Object.create(null);
LIBRARIES.forEach((l) => { DEFAULT_ENTITY_TYPE_COLOR[l.name] = l.color; });

/* ===== Outline template system =====
   Each outline type has a field skeleton (user fills in from the template); 'Custom' uses the generic skeleton.
   Creating an outline starts by picking a type, which applies the template and generates a same-name md note (with template content). */
const OUTLINE_TEMPLATES = {
  'Chapter': { emoji: '📄', fields: ['Chapter Summary', 'Characters in This Chapter', 'Setting & Place', 'Plot Progress', 'Conflict & Turn', 'Foreshadowing / Clues', 'Word Count Goal', 'Notes'] },
  'Master Outline': { emoji: '📕', fields: ['One-line Hook', 'Genre & Positioning', 'Core Conflict', 'Main Character Arcs', 'Three-Act Structure', 'Key Turning Points', 'Theme Statement', 'Planned Length'] },
  'Volume Outline': { emoji: '📗', fields: ['Goals for This Volume', 'Continuing from Previous Volume', 'Core Events', 'Key Characters', 'Setup / Development / Turn / Wrap', 'End-of-Volume Hook', 'Related Chapters'] },
  'Plot': { emoji: '🧩', fields: ['One-line Summary', 'Beginning', 'Development', 'Climax', 'Resolution', 'Characters Involved', 'Related Chapters', 'Notes'] },
  'Character': { emoji: '👤', fields: ['Role in Story', 'Appearance', 'Personality', 'Motivation & Goals', 'Abilities / Skills', 'Background', 'Relationships', 'Appears In'] },
  'Background': { emoji: '🎬', fields: ['Era & Period', 'Region & Place', 'Social Environment', 'Factions & Organizations', 'Core Rules', 'Related Lore'] },
  'Scene': { emoji: '🏞️', fields: ['Place', 'Time', 'Weather & Atmosphere', 'Characters Present', 'What Happens', 'Emotional Tone'] },
  'Foreshadowing': { emoji: '🔖', fields: ['Foreshadowing Text', 'Planted in Chapter', 'Misdirection', 'Revealed in Chapter', 'Related Characters', 'Reader Hint'] },
  'Timeline': { emoji: '⏳', fields: ['Point in Time', 'Event', 'Characters Involved', 'Place', 'Cause & Effect', 'Related Chapters'] },
  'Themes': { emoji: '🎭', fields: ['Theme Statement', 'Carried by Whom', 'Shown in Which Plot', 'Symbolic Imagery', 'Recurring Elements', 'Reader Takeaway'] },
  'Custom': { emoji: '🖋️', fields: ['Description', 'Key Points', 'Linked Items', 'Notes'] },
};
/* v2.2: fill-in hints per template field (so new notes get a 'Fill in directly' template, not just empty headings) */
const OUTLINE_FIELD_HINTS = {
  'One-line Hook': 'One sentence on what makes this story gripping.', 'Genre & Positioning': 'Genre, target readers, planned length.', 'Core Conflict': 'What the protagonist wants, and what stands in the way.',
  'Main Character Arcs': 'The protagonist\'s change from state A to state B.', 'Three-Act Structure': 'Key points for setup (inciting incident) / confrontation / turn & wrap (climax + ending).', 'Key Turning Points': 'The few nodes that change the story\'s direction.',
  'Theme Statement': 'What this book ultimately wants to say.', 'Planned Length': 'Estimated total words / chapter count.',
  'Goals for This Volume': 'The minimum this volume must accomplish.', 'Continuing from Previous Volume': 'How to pick up the hook left at the end of the previous volume.', 'Core Events': 'The 2-3 most important things in this volume.',
  'Key Characters': 'Characters who appear and grow in this volume.', 'Setup / Development / Turn / Wrap': 'This volume\'s beginning / development / turn / wrap-up.', 'End-of-Volume Hook': 'The cliffhanger pulling readers to the next volume.', 'Related Chapters': 'The chapter range this volume covers.',
  'Chapter Summary': 'What happens in this chapter (in three sentences).', 'Characters in This Chapter': 'Characters appearing in this chapter.', 'Setting & Place': 'Main scenes and places.', 'Plot Progress': 'What this chapter advances over the last one.',
  'Conflict & Turn': 'This chapter\'s conflict and turn.', 'Foreshadowing / Clues': 'Foreshadowing planted or revealed in this chapter.', 'Word Count Goal': 'Planned word count for this chapter (default 3000).',
  'One-line Summary': 'Sum up this plot in one sentence.', 'Beginning': 'How the plot begins.', 'Development': 'How the plot unfolds.', 'Climax': 'The most tense moment.', 'Resolution': 'How the plot wraps up.', 'Characters Involved': 'Characters involved.',
  'Role in Story': 'Lead / supporting / villain? What narrative function?', 'Appearance': 'Physical traits.', 'Personality': 'Personality and weaknesses.', 'Motivation & Goals': 'What they want, and why.',
  'Abilities / Skills': 'What they\'re good at.', 'Background': 'Past experiences.', 'Relationships': 'Relations with other characters.', 'Appears In': 'Chapter of first appearance.',
  'Era & Period': 'The era of the story.', 'Region & Place': 'Main geographic scope.', 'Social Environment': 'Social atmosphere.', 'Factions & Organizations': 'Major factions.', 'Core Rules': 'Rules of the world.', 'Related Lore': 'Related lore entries.',
  'Place': 'Name of the place.', 'Time': 'When it happens.', 'Weather & Atmosphere': 'Weather and mood.', 'Characters Present': 'Characters present.', 'What Happens': 'The event that takes place.', 'Emotional Tone': 'The emotional color of this scene.',
  'Foreshadowing Text': 'What foreshadowing is planted.', 'Planted in Chapter': 'Which chapter it is planted in.', 'Misdirection': 'Which way readers are misled.', 'Revealed in Chapter': 'Which chapter reveals it.', 'Reader Hint': 'The clue given to readers.',
  'Point in Time': 'The exact point in time.', 'Event': 'The event that takes place.', 'Characters Involved': 'People involved.', 'Cause & Effect': 'Ties to causes and effects.',
  'Theme Statement': 'The theme to express.', 'Carried by Whom': 'Which character carries it.', 'Shown in Which Plot': 'Which plot shows it.', 'Symbolic Imagery': 'Recurring imagery.', 'Recurring Elements': 'Recurring elements.', 'Reader Takeaway': 'What feeling should stay with readers at the end.',
  'Description': 'Description.', 'Key Points': 'Key points.', 'Linked Items': 'Related characters / plots / lore.', 'Notes': 'Other notes.'
};
function outlineTemplateFields(type) {
  const t = OUTLINE_TEMPLATES[type] || OUTLINE_TEMPLATES['Custom'];
  return t.fields;
}
function outlineEmoji(type) {
  return (OUTLINE_TEMPLATES[type] || {}).emoji || '📋';
}
/* Legacy 9 types → new library mapping (v2→v3 migration) */
const LIB_MIGRATE = { 'Character': 'Character', 'Plot': 'Storyline', 'Scene': 'Scene', 'Foreshadowing': 'Foreshadowing', 'Timeline': 'Timeline', 'Location Line': 'Geography', 'Clue': 'Clue', 'Information Gap': 'Information Gap', 'Emotion': 'Emotion' };
/* Outline types (chapter / plot / character etc., customizable) */
const DEFAULT_OUTLINE_TYPES = ['Master Outline', 'Volume Outline', 'Chapter', 'Plot', 'Character', 'Background', 'Scene', 'Foreshadowing', 'Timeline', 'Themes', 'Custom'];

/* v2.6.1: four chapter statuses (click the status tag in the catalog to cycle). Legacy mapping: blank→Draft, Draft→Writing, Revising→Needs Revision, Completed/Final→Final */
const CH_STATUS = ['Draft', 'Writing', 'Needs Revision', 'Final'];
const PLUGIN_VERSION = '1.0.0';
/* Marker of the auto-tracked "Appears In" section in lore notes (only content after the marker is replaced; user body text untouched) */
const NWS_APPEAR_MARK = '<!-- NWS:APPEARANCES -->';

/* ===== v2.1: word-count data / Pomodoro / Focus Mode ===== */
const DEFAULT_CHAPTER_TARGET = 3000;
/* Focus wallpapers: pure CSS gradients, no external images */
const FOCUS_WALLPAPERS = [
  { id: 'none', name: 'No Wallpaper', theme: 'auto', css: '' },
  { id: 'mist', name: 'Morning Mist · Light', theme: 'light', css: 'linear-gradient(135deg,#f3f0e9 0%,#e8eee9 45%,#dfe6ee 100%)' },
  { id: 'sand', name: 'Warm Sand · Light', theme: 'light', css: 'linear-gradient(135deg,#faf3e7 0%,#f0e5d2 55%,#e7d9c3 100%)' },
  { id: 'lilac', name: 'Lilac · Light', theme: 'light', css: 'linear-gradient(135deg,#f3eef5 0%,#e9e2ef 50%,#dfe6f0 100%)' },
  { id: 'paper', name: 'Paper White · Light', theme: 'light', css: 'linear-gradient(135deg,#faf8f2 0%,#f4f1e9 55%,#ece8dd 100%)' },
  /* v2.13: pure night mode — no gray haze, high-contrast dark palette (near-black base, color used only for subtle mood) */
  { id: 'midnight', name: 'Pure Black · Night', theme: 'dark', css: 'linear-gradient(180deg,#040507 0%,#07090d 60%,#050609 100%)' },
  { id: 'navy', name: 'Navy · Night', theme: 'dark', css: 'linear-gradient(180deg,#040813 0%,#081020 60%,#050a14 100%)' },
  { id: 'espresso', name: 'Dark Coffee · Night', theme: 'dark', css: 'linear-gradient(180deg,#0a0705 0%,#140d08 60%,#0a0705 100%)' },
  { id: 'forest', name: 'Ink Green · Night', theme: 'dark', css: 'linear-gradient(180deg,#040a06 0%,#0a150c 60%,#050b07 100%)' },
  { id: 'wine', name: 'Dark Wine · Night', theme: 'dark', css: 'linear-gradient(180deg,#0a0407 0%,#150a0f 60%,#0a0508 100%)' },
  { id: 'ink', name: 'Night Ink · Deep', theme: 'dark', css: 'linear-gradient(135deg,#1a2130 0%,#253048 50%,#121722 100%)' },
  { id: 'plum', name: 'Dusk Purple · Deep', theme: 'dark', css: 'linear-gradient(135deg,#221a2c 0%,#302442 50%,#170f20 100%)' },
  { id: 'graphite', name: 'Graphite · Deep', theme: 'dark', css: 'linear-gradient(135deg,#14171b 0%,#1d222a 55%,#0c0e11 100%)' },
  { id: 'darkgreen', name: 'Forest Ink · Deep', theme: 'dark', css: 'linear-gradient(135deg,#0c1712 0%,#14231c 55%,#08110c 100%)' },
];
/* Procedural ambient sound (Web Audio synthesis, no external files): looping environment audio, can be turned off anytime */
const FOCUS_SOUNDS = [
  { id: 'off', name: '🔇 Off' },
  { id: 'rain', name: '🌧 Rain' },
  { id: 'drip', name: '💧 Drips' },
  { id: 'bubble', name: '🫧 Bubbles' },
  { id: 'noise', name: '🌊 White Noise' },
];
/* v2.8: typing sound — one beep per real keypress (separate from ambient sound) */
const TYPING_SOUNDS = [
  { id: 'off', name: '🔇 Off' },
  { id: 'key', name: '⌨️ Mechanical Keys' },
  { id: 'soft', name: '🤍 Soft Keys' },
  { id: 'type', name: '📜 Typewriter' },
];
function dateKey(d) {
  const x = d ? new Date(d) : new Date();
  return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
}
function fmtDur(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + 'h' : '') + (m ? m + 'm' : '') + (s ? s + 's' : '') || '0s';
}

const TYPE_EMOJI = {
  'Character': '👤', 'Character': '👤', 'Plot': '🧩', 'Scene': '🏞️', 'Background': '🎬', 'Foreshadowing': '🔖',
  'Clue': '🔎', 'Timeline': '⏳', 'Location Line': '🗺️', 'Information Gap': '💡', 'Emotion': '💗',
  'Outline': '📋', 'Master Outline': '📕', 'Volume Outline': '📗', 'Chapter Outline': '📘'
};
function typeEmoji(t, isOutline) {
  if (LIB_BY_NAME[t]) return LIB_BY_NAME[t].emoji;
  if (TYPE_EMOJI[t]) return TYPE_EMOJI[t];
  if (/Character/i.test(t)) return '👤';
  if (/Plot|Storyline/i.test(t)) return '🧩';
  if (/Scene|Location/i.test(t)) return '🏞️';
  if (/Background/i.test(t)) return '🎬';
  if (/Foreshadowing/i.test(t)) return '🔖';
  if (/Clue/i.test(t)) return '🔎';
  if (/Timeline/i.test(t)) return '⏳';
  if (/Information/i.test(t)) return '💡';
  if (/Emotion/i.test(t)) return '💗';
  return isOutline ? '📄' : '🔹';
}

const DEFAULT_SETTINGS = {
  folderOutline: 'Outline',
  folderSetting: 'Lore',
  folderBody: 'Manuscript',
  folderInspiration: 'Ideas',          // v10: each idea gets its own same-name md note
  inspirationFile: 'Ideas.md',         // legacy field, read-only for compatibility, no longer written
  dialogueHighlight: true,
  dialogueEnglish: true,
  entityHighlight: true,
  entityNameMatch: true,
  entityAliasMatch: true,
  entityEmoji: true,
  entityClickJump: true,                // v3.0: single-click a lore word in the body to open its lore note
  noteChip: false,
  autoCollectBracket: false,
  hoverDelay: 200,
  currentPara: false,
  /* v2.1 word-count data / focus */
  chapterTarget: DEFAULT_CHAPTER_TARGET, // default word goal per chapter (a chapter can override it)
  showProgressBar: true,                // top floating gradient progress bar
  paceWindow: 60,                       // pace tracking window (seconds)
  pomodoroWork: 25,                     // Pomodoro focus minutes
  pomodoroBreak: 5,                     // short break minutes
  pomodoroLongBreak: 15,                // long break minutes
  pomodoroRounds: 4,                    // rounds before the long break
  focusMinutes: 25,                     // custom focus duration
  focusWallpaper: 'midnight',           // focus wallpaper id (default: pure night mode)
  focusSound: 'off',                   // ambient sound id (looping environment audio, can be off)
  focusSoundVolume: 0.3,               // ambient sound volume 0-1
  /* v2.8: easier to focus */
  focusFullscreen: true,               // auto fullscreen on focus (hide sidebars + system fullscreen)
  focusDim: 0.32,                      // focus overlay dimming 0-0.9 (v2.11 lowered from .55 to remove the gray haze)
  typeSound: 'off',                    // typing sound id (v2.11: muted by default, only sounds during focus sessions)
  typeSoundVolume: 0.35,               // typing sound volume 0-1
  typingMode: false,                   // typing mode: current paragraph highlighted + neighbors fading
  typingRadius: 2,                     // number of faded paragraphs
  lineMode: 'both',                    // legacy field, read for compatibility (axis toggles live in visibleAxes)
  /* v2.4: independent axis toggles — show time/location/emotion lines in any combination; inferred from lineMode when null */
  visibleAxes: ['time', 'space'],
  /* v2.7: annotations + word milestones */
  annotShow: true,                     // annotation shading toggle
  milestoneMark: true,                 // milestone marker at the line's right edge every N words
  milestoneStep: 300,                  // milestone marker at the line's right edge every 300 words
  dailyGoal: 1000,                     // v2.13: daily goal words (goal completion stats)
  /* v2.14: body typography (line height / letter spacing / first-line indent / paragraph gap / font size, unified across editing + reading + focus) */
  typoEnabled: true,                   // typography master toggle
  typoLineHeight: 1.9,                 // line height multiplier (1~3)
  typoLetterSpacing: 0,                // letter spacing (em, 0~0.3)
  typoIndent: 2,                       // first-line indent (em, 0 = none; headings/lists/quotes/code excluded automatically)
  typoParaGap: 8,                      // paragraph gap in reading view (px, 0~48)
  typoFontSize: 0,                     // body font size px (0 = follow Obsidian's appearance font size)
  /* Auto-generated "Appears In" stats table at the end of lore notes (kept) */
  appearSync: true,
};
/* ---------- Utilities ---------- */
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function fmt(n) { return (n || 0).toLocaleString('en-US'); }
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function debounce(fn, ms) {
  let h = null;
  return function () { clearTimeout(h); const a = arguments, s = this; h = setTimeout(() => fn.apply(s, a), ms); };
}
function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
}
/* Whether an entity has an explicit color: -1/null = "no color" → bold + underline in the body; otherwise colored bold */
function hasEntityColor(e) { return !!(e && e.color != null && e.color >= 0 && e.color < 6); }
/* Body skeleton content with frontmatter stripped (used by the hover card to preview lore content) */
function fileBody(text) {
  return String(text || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
}
function stripForCount(text) {
  let t = String(text || '');
  t = t.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  t = t.replace(/```[\s\S]*?```/g, '');
  t = t.replace(/^#{1,6}\s.*$/gm, '');
  t = t.replace(/\[[^\]]*\]/g, '');
  return t;
}
function countWords(text) {
  let t = stripForCount(text);
  t = t.replace(/[，。！？；：、“”‘’《》（）【】—…、,.!?;:'"()\[\]{}<>《》\-]/g, '');
  const cjk = (t.match(/[\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/g) || []).length;
  const latin = (t.match(/[A-Za-z0-9]+/g) || []).length;
  return cjk + latin;
}
/* Count total occurrences of several terms in a text (longest first, non-overlapping) */
function countTerms(text, terms) {
  const list = (terms || []).filter((x) => x && String(x).trim()).map((x) => String(x));
  if (!list.length) return 0;
  list.sort((a, b) => b.length - a.length);
  const re = new RegExp(list.map(escapeRegex).join('|'), 'g');
  const m = stripForCount(text).match(re);
  return m ? m.length : 0;
}
function stamp() { return new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
function stampFrom(ts) { if (!ts) return ''; return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }

/* ================= Plugin main class ================= */
class NovelWriterStudio extends Plugin {
  async onload() {
    const saved = (await this.loadData()) || {};
    const schemaBefore = saved.schemaVersion || 0;
    this.data = this.normalizeData(saved);
    const schemaUpgraded = schemaBefore < 14;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, this.data.settings || {});
    /* v2.8 migration: legacy "soft keys" moved from ambient sound to typing sound */
    if (this.settings.focusSound === 'key') { this.settings.focusSound = 'off'; }
    /* v2.11: typing sound muted by default; only zero out values never set, respecting sounds the user chose */
    if (this.settings.typeSound === undefined || this.settings.typeSound === null || this.settings.typeSound === 'key') this.settings.typeSound = 'off';
    if (this.settings.focusWallpaper === 'mist' || this.settings.focusWallpaper === 'graphite' || this.settings.focusWallpaper === 'pine' || this.settings.focusWallpaper === 'slate' || this.settings.focusWallpaper === 'coffee' || this.settings.focusWallpaper === 'amber') this.settings.focusWallpaper = 'midnight';
    /* v2.11 migration: legacy overlay 0.55 too gray → brighten to 0.32 (user custom values respected) */
    if (this.settings.focusDim === 0.55) this.settings.focusDim = 0.32;
    /* v2.10 migration: milestone 500 → 300; only changed when still the old default, user custom values respected */
    if (this.settings.milestoneStep === 500) this.settings.milestoneStep = 300;

    this.entityVersion = 0;
    this.wordCache = Object.create(null);
    this.stats = { perEntity: Object.create(null), perChapter: Object.create(null), chapters: [], totalWords: 0 };
    this.capturing = false;
    this.scheduleSave = debounce(() => this.saveNow(), 1000);
    this.scheduleRescan = debounce(() => this.rescan(true), 600);
    this.scheduleAppearSync = debounce(() => this.syncEntityAppearances(), 2500);
    /* v2.1 live word-count state */
    this.paceSamples = [];              // [{t, w}] recent typing samples (live pace)
    this.liveCounts = Object.create(null); // path -> last recorded word count (avoids double counting with rescan)
    this._lastTypeAt = 0;
    this.focusState = { active: false, wallpaper: '', sound: null, timer: null, endAt: 0, seconds: 0, paused: false, left: 0, mode: '' };
    this.pomodoro = { running: false, timer: null, left: 0, phase: 'work', round: 0 };

    /* Defensive loading: a failed step only logs, never takes down the whole plugin */
    const step = async (label, fn) => { try { await fn(); } catch (e) { console.error('[Novel Writing] ' + label + ' failed:', e); } };
    await step('Init folder structure', () => this.ensureStructure());
    await step('Sync lore folders', () => this.ensureLibFolders());
    await step('Lore files → index', () => this.syncFilesToIndex());
    await step('Outline files → index', () => this.syncOutlineFiles());
    await step('Lore index → files', () => this.ensureEntityFiles());
    await step('Write category ownership', () => this.ensureGroupMeta());
    await step('Sort lore into category folders', () => this.migrateEntityFolders());
    await step('Clean template hints', () => this.cleanTemplateHints());
    await step('Outline index → files', () => this.ensureOutlineFiles());
    await step('Idea index → files', () => this.ensureNoteFiles());
    await step('Idea files → index', () => this.syncNoteFiles());
    await step('Clean legacy Ideas.md', () => this.retireOldInspirationFile());
    await step('Stats scan', () => this.rescan(false));
    await step('Apply typography', () => this.applyTypo());
    await step('Persist v1.0 schema', async () => { if (schemaUpgraded) await this.saveNow(); });

    this.registerView(VIEW_CATALOG, (leaf) => new CatalogView(leaf, this));
    this.registerView(VIEW_OUTLINE, (leaf) => new OutlineView(leaf, this));
    this.registerView(VIEW_ENTITIES, (leaf) => new EntitiesView(leaf, this));
    this.registerView(VIEW_NOTES, (leaf) => new NotesView(leaf, this));
    this.registerView(VIEW_PLOTS, (leaf) => new PlotsView(leaf, this));
    this.registerView(VIEW_LINES, (leaf) => new LinesView(leaf, this));
    this.registerView(VIEW_STATS, (leaf) => new StatsView(leaf, this));
    this.registerView(VIEW_ANNOT, (leaf) => new AnnotsView(leaf, this));
    /* v1.0: planning & scenes */
    this.registerView(VIEW_GANTT, (leaf) => new GanttView(leaf, this));
    this.registerView(VIEW_RELEASE, (leaf) => new ReleaseView(leaf, this));
    this.registerView(VIEW_SCENES, (leaf) => new ScenesView(leaf, this));

    if (HAS_CM) {
      this.registerEditorExtension(this.buildMarkExtension());
      console.log('[Novel Writing] CM6 body decoration layer registered (lore highlight / quotes / annotations / milestones active)');
    } else {
      console.error('[Novel Writing] CM6 decoration layer failed to load; body highlighting unavailable. Diagnosis: ', cmLoadErrors.join(' | ') || 'module did not export decoration classes');
    }

    this.addRibbonIcon('folder-tree', 'Studio · Catalog', () => this.activateView(VIEW_CATALOG));
    this.addRibbonIcon('list-tree', 'Studio · Outline', () => this.activateView(VIEW_OUTLINE));
    this.addRibbonIcon('shapes', 'Studio · Lore Library', () => this.activateView(VIEW_ENTITIES));
    this.addRibbonIcon('git-branch', 'Studio · Plot', () => this.activateView(VIEW_PLOTS));
    this.addRibbonIcon('git-merge', 'Studio · Time / Location / Emotion Lines', () => this.activateView(VIEW_LINES));
    this.addRibbonIcon('lightbulb', 'Studio · Ideas', () => this.activateView(VIEW_NOTES));
    this.addRibbonIcon('chart-no-axes-column', 'Studio · Data Center', () => this.activateView(VIEW_STATS));
    this.addRibbonIcon('sticky-note', 'Studio · Annotations', () => this.activateView(VIEW_ANNOT));
    /* v1.0: planning & scenes */
    this.addRibbonIcon('calendar-range', 'Studio · Gantt Chart', () => this.activateView(VIEW_GANTT));
    this.addRibbonIcon('send', 'Studio · Release Plan', () => this.activateView(VIEW_RELEASE));
    this.addRibbonIcon('layout-grid', 'Studio · Story Scenes', () => this.activateView(VIEW_SCENES));
    this.addRibbonIcon('palette', 'Studio · Writing Scenes', () => new ScenePresetModal(this.app, this).open());
    this.addRibbonIcon('search', 'Studio · Find & Replace', () => new FindReplaceModal(this.app, this).open());
    this.addRibbonIcon('timer', 'Studio · Pomodoro', () => new FocusModal(this.app, this, 'pomodoro').open());
    this.addRibbonIcon('eye', 'Studio · Focus Mode', () => new FocusModal(this.app, this, 'focus').open());

    this.buildHover();
    this.buildAnnotHover();
    this.buildProgressBar();
    this.buildFocusHUD();
    this.registerCommands();
    this.registerContextMenu();
    this.registerEvent(this.app.vault.on('modify', () => this.scheduleRescan()));
    this.registerEvent(this.app.vault.on('create', () => this.scheduleRescan()));
    this.registerEvent(this.app.vault.on('delete', () => this.scheduleRescan()));
    this.registerEvent(this.app.vault.on('rename', () => this.scheduleRescan()));
    /* v2.1: refresh the progress bar on file/editor changes; a timer decays live pace and refreshes the bar */
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.refreshProgressBar()));
    this._barTimer = setInterval(() => this.tickLive(), 1000);
    this.registerInterval(this._barTimer);

    this.addSettingTab(new NSSettingTab(this.app, this));
    setTimeout(() => this.refreshViews(), 800);
    /* Load success notice: HAS_CM directly reflects whether body highlighting is available (v2.10 root-cause fix) */
    const migrated = !saved.schemaVersion || saved.schemaVersion < 13;
    const cmNote = HAS_CM ? 'Body lore highlighting is ready' : '⚠️ Body highlighting unavailable (CM6 not loaded, see console)';
    setTimeout(() => new Notice('📖 Novel Writing v' + PLUGIN_VERSION + ' loaded' + (migrated ? ' · old data migrated' : '') + ' · ' + cmNote), 1200);
  }

  onunload() {
    if (this.hoverEl) this.hoverEl.remove();
    if (this.barEl) this.barEl.remove();
    if (this.hudEl) this.hudEl.remove();
    clearTimeout(this.hoverTimer); clearTimeout(this.hoverHideTimer);
    if (this._barTimer) clearInterval(this._barTimer);
    this.stopSound();
    this.clearFocusWallpaper();
    /* v2.14: remove the typography style injection on unload */
    if (this._typoStyle) { try { this._typoStyle.remove(); } catch (e) {} this._typoStyle = null; }
    try { document.body.classList.remove('nws-typo-on'); } catch (e) {}
    if (this.pomodoro && this.pomodoro.timer) clearInterval(this.pomodoro.timer);
    if (this.focusState && this.focusState.timer) clearInterval(this.focusState.timer);
  }

  /* ---------- v2.14 body typography ---------- */
  /* Inject CSS variables via a dynamic style tag: unified across editing view (CM6) + reading view + focus mode;
     headings/lists/quotes/code/table rows are excluded from first-line indent and letter spacing to keep Markdown structure intact. */
  applyTypo() {
    try {
      const s = this.settings;
      if (!this._typoStyle) {
        const st = document.createElement('style');
        st.id = 'nws-typo-style';
        (document.head || document.body).appendChild(st);
        this._typoStyle = st;
      }
      const on = s.typoEnabled !== false;
      try {
        if (on) document.body.classList.add('nws-typo-on');
        else document.body.classList.remove('nws-typo-on');
      } catch (e) {}
      if (!on) { this._typoStyle.textContent = ''; return; }
      const lh = clamp(Number(s.typoLineHeight) || 1.9, 1, 3);
      const ls = clamp(Number(s.typoLetterSpacing) || 0, 0, 0.3);
      const ind = clamp(Number(s.typoIndent) || 0, 0, 4);
      const gap = clamp(Number(s.typoParaGap) || 0, 0, 48);
      const fs = clamp(Number(s.typoFontSize) || 0, 0, 28);
      let css = 'body.nws-typo-on{--nws-lh:' + lh + ';--nws-ls:' + ls + 'em;--nws-ind:' + ind + 'em;--nws-gap:' + gap + 'px;}';
      if (fs >= 12) css += 'body.nws-typo-on{--font-size:' + fs + 'px !important;}';
      /* Editing view (CM6 source / live preview) */
      css += 'body.nws-typo-on .markdown-source-view.mod-cm6 .cm-content > .cm-line{line-height:var(--nws-lh);letter-spacing:var(--nws-ls);text-indent:var(--nws-ind);}';
      /* Non-body lines: no indent, no letter spacing (headings/lists/quotes/code/tables) */
      const exSel = ['HyperMD-header', 'HyperMD-list-line', 'HyperMD-quote', 'HyperMD-codeblock', 'HyperMD-table-row', 'HyperMD-hr']
        .map((c) => 'body.nws-typo-on .markdown-source-view.mod-cm6 .cm-content > .cm-line.' + c).join(',');
      css += exSel + '{text-indent:0;letter-spacing:0;}';
      /* Reading view */
      css += 'body.nws-typo-on .markdown-reading-view .markdown-preview-view{line-height:var(--nws-lh);letter-spacing:var(--nws-ls);}';
      css += 'body.nws-typo-on .markdown-reading-view .markdown-preview-view p{line-height:var(--nws-lh);text-indent:var(--nws-ind);margin-block-end:var(--nws-gap);}';
      css += 'body.nws-typo-on .markdown-reading-view .markdown-preview-view h1,'
        + 'body.nws-typo-on .markdown-reading-view .markdown-preview-view h2,'
        + 'body.nws-typo-on .markdown-reading-view .markdown-preview-view h3,'
        + 'body.nws-typo-on .markdown-reading-view .markdown-preview-view h4,'
        + 'body.nws-typo-on .markdown-reading-view .markdown-preview-view li,'
        + 'body.nws-typo-on .markdown-reading-view .markdown-preview-view blockquote,'
        + 'body.nws-typo-on .markdown-reading-view .markdown-preview-view pre,'
        + 'body.nws-typo-on .markdown-reading-view .markdown-preview-view table{text-indent:0;}';
      this._typoStyle.textContent = css;
      /* Let CM6 re-measure line heights after a font-size change to avoid cursor misalignment */
      try {
        this.app.workspace.iterateCodeMirrors((cm) => { if (cm && cm.requestMeasure) cm.requestMeasure(); });
      } catch (e) {}
    } catch (e) { console.error('[Novel Writing] Failed to apply typography:', e); }
  }

  /* ---------- Data ---------- */
  normalizeData(d) {
    d = d || {};
    d.entities = d.entities || [];
    d.outlines = d.outlines || [];
    d.notes = d.notes || [];
    d.chapters = d.chapters || {};
    d.entityTypes = d.entityTypes && d.entityTypes.length ? d.entityTypes : DEFAULT_ENTITY_TYPES.slice();
    d.outlineTypes = d.outlineTypes && d.outlineTypes.length ? d.outlineTypes : DEFAULT_OUTLINE_TYPES.slice();
    d.typeColors = d.typeColors || Object.assign({}, DEFAULT_ENTITY_TYPE_COLOR);
    d.settings = d.settings || {};
    /* One-time migration: legacy 6 lore types → new 9 (custom types and colors kept) */
    if (!d.schemaVersion || d.schemaVersion < 2) {
      const OLD = ['Character', 'Background', 'Environment', 'Foreshadowing', 'Information Gap', 'Clue'];
      const mapType = { 'Character': 'Character', 'Background': 'Scene', 'Environment': 'Scene' };
      const custom = (d.entityTypes || []).filter((t) => OLD.indexOf(t) < 0 && DEFAULT_ENTITY_TYPES.indexOf(t) < 0);
      d.entities.forEach((e) => { if (mapType[e.type]) { e.type = mapType[e.type]; e.color = DEFAULT_ENTITY_TYPE_COLOR[e.type]; } });
      d.entityTypes = DEFAULT_ENTITY_TYPES.slice().concat(custom);
      const newColors = Object.assign({}, DEFAULT_ENTITY_TYPE_COLOR);
      Object.keys(d.typeColors || {}).forEach((k) => { if (d.entityTypes.indexOf(k) >= 0 && newColors[k] == null) newColors[k] = d.typeColors[k]; });
      d.typeColors = newColors;
      d.schemaVersion = 2;
    }
    /* v3 migration: 9 types/custom → 12 template libraries (file-based). Custom libraries and user colors kept */
    if (!d.schemaVersion || d.schemaVersion < 3) {
      const customTypes = (d.entityTypes || []).filter((t) => !LIB_MIGRATE[t] && !LIB_BY_NAME[t]);
      d.entities.forEach((e) => {
        let nt = LIB_MIGRATE[e.type] || e.type;
        if (!LIB_BY_NAME[nt] && customTypes.indexOf(nt) < 0) nt = 'Character';
        e.type = nt;
        if (e.color == null) e.color = (LIB_BY_NAME[nt] ? LIB_BY_NAME[nt].color : 2);
      });
      d.entityTypes = DEFAULT_ENTITY_TYPES.slice().concat(customTypes);
      const colors = Object.assign({}, DEFAULT_ENTITY_TYPE_COLOR);
      Object.keys(d.typeColors || {}).forEach((k) => { if (d.entityTypes.indexOf(k) >= 0 && colors[k] == null) colors[k] = d.typeColors[k]; });
      d.typeColors = colors;
      d.schemaVersion = 3;
    }
    /* v4 migration: added plots and time-location dual lines (timeline / spaceline nodes) */
    if (!d.schemaVersion || d.schemaVersion < 4) {
      d.plots = d.plots || [];
      d.lineNodes = d.lineNodes || [];
      d.schemaVersion = 4;
    }
    /* v5 migration: ideas gained linked targets and processing status */
    if (!d.schemaVersion || d.schemaVersion < 5) {
      (d.notes || []).forEach((n) => { n.bindings = n.bindings || []; n.status = n.status || 'Pending'; });
      d.schemaVersion = 5;
    }
    /* v6 migration: added the "Custom" lore library; outlines became file-based (added file/color/tags fields) */
    if (!d.schemaVersion || d.schemaVersion < 6) {
      if ((d.entityTypes || []).indexOf('Custom') < 0) (d.entityTypes || []).push('Custom');
      if (d.typeColors && d.typeColors['Custom'] == null) d.typeColors['Custom'] = 5;
      (d.outlines || []).forEach((o) => { o.color = o.color == null ? 3 : o.color; o.tags = o.tags || []; o.file = o.file || ''; });
      d.schemaVersion = 6;
    }
    /* v7 migration: two-level lore library — each entry is filed under one of 8 categories by its type; unclassifiable ones go to "Standalone".
       Added Themes/Writing Style types and default colors, and merged all new libraries into entityTypes. */
    if (!d.schemaVersion || d.schemaVersion < 7) {
      LIBRARIES.forEach((l) => { if ((d.entityTypes || []).indexOf(l.name) < 0) (d.entityTypes || []).push(l.name); });
      const colors = Object.assign({}, DEFAULT_ENTITY_TYPE_COLOR);
      Object.keys(d.typeColors || {}).forEach((k) => { if (colors[k] == null) colors[k] = d.typeColors[k]; });
      d.typeColors = colors;
      (d.entities || []).forEach((e) => { e.group = groupOfLib(e.type); });
      d.schemaVersion = 7;
    }
    /* v8 migration: word-count log (by day), chapter word goals, focus sessions */
    if (!d.schemaVersion || d.schemaVersion < 8) {
      d.daily = d.daily || {};        // { 'YYYY-MM-DD': { words, secs, focus, sessions } }
      d.focusSessions = d.focusSessions || [];
      d.schemaVersion = 8;
    }
    /* v9 migration: multi-track time/location lines — the two legacy fixed lines (line='time'|'space') become tracks */
    if (!d.schemaVersion || d.schemaVersion < 9) {
      d.tracks = d.tracks || [];
      if (!d.tracks.length) {
        d.tracks.push({ id: 'trk_time', name: 'Main Timeline', axis: 'time', view: 'event', order: 0, created: Date.now() });
        d.tracks.push({ id: 'trk_space', name: 'Main Location Line', axis: 'space', view: 'space', order: 1, created: Date.now() });
      }
      (d.lineNodes || []).forEach((n) => {
        if (!n.trackId) n.trackId = (n.line === 'space' ? 'trk_space' : 'trk_time');
        if (!n.view) n.view = (n.line === 'space' ? 'space' : 'event');
      });
      d.schemaVersion = 9;
    }
    /* v10 migration: ideas became file-based — one md note per idea (Ideas/<Title>.md).
       Legacy notes data kept and materialized to files by ensureNoteFiles at load; the single Ideas.md is deleted. */
    if (!d.schemaVersion || d.schemaVersion < 10) {
      d.settings = d.settings || {};
      if (!d.settings.folderInspiration) d.settings.folderInspiration = 'Ideas';
      (d.notes || []).forEach((n) => { n.file = n.file || ''; });
      d.schemaVersion = 10;
    }
    /* v11 migration: independent axis toggles + track-level links. Legacy lineMode single/dual → visibleAxes array; tracks get bindings.
       No emotion track is added automatically (the user's 'can be time-only / location-only' choice is respected); users create their own as needed. */
    if (!d.schemaVersion || d.schemaVersion < 11) {
      d.settings = d.settings || {};
      const m = d.settings.lineMode || 'both';
      d.settings.visibleAxes = (m === 'time') ? ['time'] : (m === 'space') ? ['space'] : ['time', 'space'];
      (d.tracks || []).forEach((t) => { t.bindings = t.bindings || []; });
      d.schemaVersion = 11;
    }
    /* v12 migration: lore library simplified to big categories only (6 + Standalone). All entries re-filed into new categories by their library:
       Themes→World Bible, Writing Style/Custom→Standalone, the rest follow the new LIB_GROUP mapping. */
    if (!d.schemaVersion || d.schemaVersion < 12) {
      (d.entities || []).forEach((e) => { e.group = groupOfLib(e.type); });
      d.schemaVersion = 12;
    }
    /* v13 migration: chapter statuses become Draft/Writing/Needs Revision/Final (legacy 0 blank→0 Draft, 1 Draft→1 Writing, 2 Revising→2 Needs Revision, 3 Completed/4 Final→3 Final) */
    if (!d.schemaVersion || d.schemaVersion < 13) {
      Object.keys(d.chapters || {}).forEach((p) => {
        const m = d.chapters[p];
        if (m && m.status != null) m.status = Math.min(Number(m.status) || 0, 3);
      });
      d.schemaVersion = 13;
    }
    d.tracks = d.tracks || [];
    (d.lineNodes || []).forEach((n) => { if (!n.trackId) n.trackId = (n.line === 'space' ? 'trk_space' : 'trk_time'); });
    d.daily = d.daily || {};
    d.focusSessions = d.focusSessions || [];
    d.pomo = d.pomo || { started: 0, completed: 0 }; // v2.13 Pomodoro completion rate
    Object.keys(d.daily).forEach((k) => { const dd = d.daily[k]; if (dd && !Array.isArray(dd.hours)) dd.hours = Object.assign(Array(24).fill(0), dd.hours || {}); });
    Object.keys(d.chapters || {}).forEach((p) => {
      const m = d.chapters[p];
      if (m && m.target == null) m.target = 0; // 0 = not set individually, use the global default
      if (m) m.timing = Object.assign({ open: 0, active: 0, focus: 0, written: 0 }, m.timing || {}); // v2.5 per-chapter timing
    });
    d.plots = d.plots || [];
    d.lineNodes = d.lineNodes || [];
    d.entities.forEach((e) => { e.bindings = e.bindings || []; e.aliases = e.aliases || []; e.group = e.group || groupOfLib(e.type); });
    d.outlines.forEach((o) => { o.bindings = o.bindings || []; o.color = o.color == null ? 3 : o.color; o.tags = o.tags || []; o.file = o.file || ''; });
    d.plots.forEach((p) => { p.stages = p.stages || {}; p.roles = p.roles || []; p.tags = p.tags || []; p.chapters = p.chapters || []; });
    d.lineNodes.forEach((n) => { n.bindings = n.bindings || []; });
    d.tracks.forEach((t) => { t.bindings = t.bindings || []; });
    d.settings.visibleAxes = Array.isArray(d.settings.visibleAxes) && d.settings.visibleAxes.length
      ? d.settings.visibleAxes : (d.settings.lineMode === 'time' ? ['time'] : d.settings.lineMode === 'space' ? ['space'] : ['time', 'space']);
    (d.notes || []).forEach((n) => { n.bindings = n.bindings || []; n.status = n.status || 'Pending'; });
    /* v2.7: annotation data (original text never modified, saved with the chapter) */
    d.annotations = Array.isArray(d.annotations) ? d.annotations : [];
    d.annotations.forEach((a) => { a.id = a.id || uid(); a.quote = a.quote || ''; a.note = a.note || ''; a.path = a.path || ''; a.from = a.from || 0; a.to = a.to || 0; a.created = a.created || Date.now(); });
    /* v1.0: Gantt chart / Release plan / Story scenes / Writing scene presets */
    if (!d.schemaVersion || d.schemaVersion < 14) {
      d.ganttTasks = Array.isArray(d.ganttTasks) ? d.ganttTasks : [];
      d.releases = Array.isArray(d.releases) ? d.releases : [];
      d.sceneCards = Array.isArray(d.sceneCards) ? d.sceneCards : [];
      d.sceneFields = Array.isArray(d.sceneFields) && d.sceneFields.length ? d.sceneFields : [
        { key: 'pov', name: 'POV' }, { key: 'location', name: 'Location' },
        { key: 'time', name: 'Time' }, { key: 'mood', name: 'Mood' }
      ];
      d.scenePresets = Array.isArray(d.scenePresets) && d.scenePresets.length ? d.scenePresets : defaultScenePresets();
      d.schemaVersion = 14;
    }
    d.ganttTasks = Array.isArray(d.ganttTasks) ? d.ganttTasks : [];
    d.releases = Array.isArray(d.releases) ? d.releases : [];
    d.sceneCards = Array.isArray(d.sceneCards) ? d.sceneCards : [];
    d.sceneFields = Array.isArray(d.sceneFields) && d.sceneFields.length ? d.sceneFields : [
      { key: 'pov', name: 'POV' }, { key: 'location', name: 'Location' },
      { key: 'time', name: 'Time' }, { key: 'mood', name: 'Mood' }
    ];
    d.scenePresets = Array.isArray(d.scenePresets) && d.scenePresets.length ? d.scenePresets : defaultScenePresets();
    d.ganttTasks.forEach((t) => { t.id = t.id || uid(); t.title = t.title || ''; t.chapter = t.chapter || ''; t.start = t.start || dateKey(); t.end = t.end || t.start; t.progress = clamp(Number(t.progress) || 0, 0, 100); t.color = t.color == null ? 0 : t.color; t.notes = t.notes || ''; });
    d.releases.forEach((r) => { r.id = r.id || uid(); r.title = r.title || ''; r.chapter = r.chapter || ''; r.platform = r.platform || ''; r.date = r.date || ''; r.status = RELEASE_STATUSES.indexOf(r.status) >= 0 ? r.status : RELEASE_STATUSES[0]; r.notes = r.notes || ''; });
    d.sceneCards.forEach((s) => { s.id = s.id || uid(); s.title = s.title || ''; s.chapter = s.chapter || ''; s.status = SCENE_STATUSES.indexOf(s.status) >= 0 ? s.status : SCENE_STATUSES[0]; s.summary = s.summary || ''; s.fields = s.fields || {}; s.color = s.color == null ? 0 : s.color; });
    d.sceneFields.forEach((f) => { f.key = f.key || uid(); f.name = f.name || 'Field'; });
    d.scenePresets.forEach((pr) => { pr.id = pr.id || uid(); pr.name = pr.name || 'Scene'; pr.icon = pr.icon || '\u270D\uFE0F'; pr.settings = pr.settings || {}; });
    return d;
  }
  async saveNow() { this.data.settings = this.settings; await this.saveData(this.data); }
  scheduleSaveSoon() { this.scheduleSave(); }

  /* ---------- Folder structure ---------- */
  async ensureFolder(path) {
    const parts = normalizePath(path).split('/').filter(Boolean);
    let cur = '';
    for (const part of parts) {
      cur = cur ? cur + '/' + part : part;
      if (!this.app.vault.getAbstractFileByPath(cur)) {
        try { await this.app.vault.createFolder(cur); } catch (e) { /* already exists */ }
      }
    }
  }
  async ensureStructure() {
    await this.ensureFolder(this.settings.folderOutline);
    await this.ensureFolder(this.settings.folderSetting);
    await this.ensureFolder(this.settings.folderBody);
    await this.ensureFolder(this.inspirationRoot());
  }

  /* ========== Lore/outline file engine ==========
     v1.5: lore switched to flat storage (Lore/<Name>.md), the library became a frontmatter type,
     no more 15 physical subfolders; legacy Lore/<Lib>/<Name>.md stays readable and auto-migrates to the flat path on edit. */
  libFolder(lib) { return normalizePath(this.settings.folderSetting || 'Lore'); }
  /* v2.11: sort lore by category into Lore/<Category>/ subfolders */
  entityFolder(e) { return normalizePath(this.libFolder() + '/' + groupFolderOf(e)); }
  allLibs() {
    const names = this.data.entityTypes.slice();
    LIBRARIES.forEach((l) => { if (names.indexOf(l.name) < 0) names.push(l.name); });
    return names.map((n) => LIB_BY_NAME[n] || { name: n, emoji: LIB_BY_NAME[n] ? LIB_BY_NAME[n].emoji : '🔹', color: (this.data.typeColors[n] == null ? 2 : this.data.typeColors[n]), fields: [] });
  }
  libDef(lib) { return LIB_BY_NAME[lib] || (this.data.entityTypes.indexOf(lib) >= 0 ? LIB_BY_NAME['Custom'] : null); }
  templateFieldsHint(lib, group) {
    const def = this.libDef(lib);
    const fields = (def && def.fields && def.fields.length) ? def.fields : (group ? groupFields(group) : ['Description']);
    return 'Template fields: ' + fields.join(' · ');
  }
  safeFileName(name) {
    return String(name || 'Untitled').replace(/[\\/:*?"<>|#\[\]^]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Untitled';
  }
  /* Generate the YAML frontmatter of a lore file (the file is the core metadata carrier) */
  entityFrontmatter(e) {
    const lines = [
      '---',
      'nws_id: ' + e.id,
      'nws_name: ' + JSON.stringify(String(e.name || '')),
      'nws_type: ' + String(e.type || 'Character'),
      'nws_group: ' + JSON.stringify(String(e.group || groupOfLib(e.type))),
      'nws_aliases: [' + (e.aliases || []).map((a) => JSON.stringify(String(a))).join(', ') + ']',
      'nws_color: ' + (e.color == null ? -1 : e.color),
      'nws_bindings: ' + JSON.stringify(e.bindings || []),
      'nws_created: ' + (e.created || Date.now()),
      'nws_desc: ' + JSON.stringify(String(e.desc || '')),
      '---'
    ];
    return lines.join('\n');
  }
  /* Generate the template body skeleton (only on creation) */
  entityTemplateBody(e) {
    const lib = this.libDef(e.type);
    const grp = e.group || groupOfLib(e.type);
    const fields = (lib && lib.fields && lib.fields.length) ? lib.fields : groupFields(grp);
    let body = '\n# ' + String(e.name || '') + '\n\n';
    fields.forEach((f) => { body += '## ' + f + '\n\n'; });
    return body;
  }
  /* Create or update a lore file; on update keep the user's handwritten body and only replace frontmatter */
  async writeEntityFile(e, isNew) {
    const dir = this.entityFolder(e);
    await this.ensureFolder(dir);
    const fname = this.safeFileName(e.name) + '.md';
    let path = normalizePath(dir + '/' + fname);
    // legacy path (library change / rename) needs migration
    if (e.file && e.file !== path) {
      const old = this.app.vault.getAbstractFileByPath(e.file);
      if (old instanceof TFile) {
        try { await this.app.vault.rename(old, path); } catch (err) { /* target conflicts etc. — creation below as fallback */ }
      }
    }
    let file = this.app.vault.getAbstractFileByPath(path);
    const fm = this.entityFrontmatter(e);
    if (file instanceof TFile) {
      let old = await this.app.vault.cachedRead(file);
      const body = old.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
      const newContent = fm + '\n' + (body || this.entityTemplateBody(e));
      if (newContent !== old) await this.app.vault.modify(file, newContent);
    } else {
      file = await this.app.vault.create(path, fm + this.entityTemplateBody(e));
    }
    e.file = path;
    return file;
  }
  /* Parse metadata from file frontmatter */
  async readEntityMeta(file) {
    let t = '';
    try { t = await this.app.vault.cachedRead(file); } catch (e) { return null; }
    const m = t.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return null;
    const fm = m[1];
    const get = (k) => { const r = new RegExp('^' + k + ':\\s*(.*)$', 'm').exec(fm); return r ? r[1].trim() : null; };
    const id = get('nws_id');
    if (!id) return null;
    const parseJSON = (s, fallback) => { try { return JSON.parse(s); } catch (e) { return fallback; } };
    return {
      id: id,
      type: get('nws_type') || 'Character',
      group: parseJSON(get('nws_group') || '""', '') || groupOfLib(get('nws_type') || 'Character'),
      aliases: parseJSON(get('nws_aliases') || '[]', []),
      color: parseInt(get('nws_color'), 10),
      bindings: parseJSON(get('nws_bindings') || '[]', []),
      created: parseInt(get('nws_created'), 10) || Date.now(),
      desc: parseJSON(get('nws_desc') || '""', ''),
      file: file.path,
      name: parseJSON(get('nws_name') || '""', '') || file.basename
    };
  }
  /* Files → memory: scan lore folders, index new files, update indexed entities from file metadata */
  async syncFilesToIndex() {
    const settingRoot = normalizePath(this.settings.folderSetting || 'Lore');
    const tracked = Object.create(null);
    this.data.entities.forEach((e) => { if (e.file) tracked[e.file] = e; });
    const files = this.app.vault.getMarkdownFiles().filter((f) => f.path.indexOf(settingRoot + '/') === 0);
    let changed = false;
    for (const f of files) {
      const meta = await this.readEntityMeta(f);
      if (!meta) continue; // md not managed by this plugin (e.g. handwritten notes), skip
      tracked[f.path] = true;
      let e = this.data.entities.find((x) => x.id === meta.id);
      if (!e) {
        e = { id: meta.id, name: meta.name, type: meta.type, group: meta.group, color: meta.color, aliases: meta.aliases, desc: meta.desc, bindings: meta.bindings, created: meta.created, file: f.path };
        this.data.entities.push(e);
        changed = true;
      } else {
        // file wins: overwrite from file metadata (editing frontmatter directly in Obsidian takes effect)
        const oldName = e.name;
        e.name = meta.name; e.type = meta.type; e.group = meta.group || groupOfLib(meta.type); e.color = isNaN(meta.color) ? e.color : meta.color;
        e.aliases = meta.aliases; e.desc = meta.desc; e.bindings = meta.bindings; e.file = f.path;
        if (oldName !== meta.name) changed = true;
      }
    }
    // file was deleted → remove from index (only entries created by this plugin that carry a file)
    const livePaths = Object.create(null);
    files.forEach((f) => { livePaths[f.path] = 1; });
    const before = this.data.entities.length;
    this.data.entities = this.data.entities.filter((e) => !e.file || livePaths[e.file]);
    if (this.data.entities.length !== before) changed = true;
    if (changed) await this.saveNow();
  }
  /* Memory → files: write legacy entries that have no file yet to md (for migration) */
  async ensureEntityFiles() {
    let changed = false;
    for (const e of this.data.entities) {
      if (!e.file || !this.app.vault.getAbstractFileByPath(e.file)) {
        await this.writeEntityFile(e, true);
        changed = true;
      }
    }
    if (changed) await this.saveNow();
  }
  /* v2.0: backfill nws_group (category) for legacy lore files, keeping the user's handwritten body.
     Only frontmatter changes, body untouched; files already carrying nws_group are skipped. */
  async ensureGroupMeta() {
    let changed = false;
    for (const e of this.data.entities) {
      if (!e.file) continue;
      const f = this.app.vault.getAbstractFileByPath(e.file);
      if (!(f instanceof TFile)) continue;
      let old = '';
      try { old = await this.app.vault.cachedRead(f); } catch (err) { continue; }
      const fmBlock = (old.match(/^---\r?\n[\s\S]*?\r?\n---/) || [''])[0];
      if (fmBlock.indexOf('nws_group:') >= 0) continue; // already present
      e.group = e.group || groupOfLib(e.type);
      await this.writeEntityFile(e, false);   // replace frontmatter only, body kept
      changed = true;
    }
    if (changed) await this.saveNow();
  }
  /* v2.11: move lore files from flat/legacy folders into Lore/<Category>/ subfolders (body and frontmatter kept as-is) */
  async migrateEntityFolders() {
    let changed = false;
    for (const e of this.data.entities) {
      if (!e.file) continue;
      const want = this.entityFolder(e) + '/' + this.safeFileName(e.name) + '.md';
      const normWant = normalizePath(want);
      if (normalizePath(e.file) === normWant) continue;
      const old = this.app.vault.getAbstractFileByPath(e.file);
      if (old instanceof TFile) {
        try { await this.app.vault.rename(old, normWant); e.file = normWant; changed = true; }
        catch (err) { console.error('[Novel Writing] Failed to move lore into category folders:', e.name, err); }
      } else {
        e.file = normWant; changed = true;
      }
    }
    if (changed) await this.saveNow();
  }
  /* v2.3: clean up the "template boilerplate" (visible hint lines) in template files — only lines written by the plugin are removed, user body text kept */
  async cleanTemplateHints() {
    const roots = [normalizePath(this.settings.folderSetting || 'Lore'), normalizePath(this.settings.folderOutline || 'Outline')];
    const kill = /Managed by .?Novel Writing.?|type \[.{0,80}\] in the body|content is auto-collected here|template library[::].*Managed by/;
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (!roots.some((r) => f.path.indexOf(r + '/') === 0)) continue;
      let text = '';
      try { text = await this.app.vault.cachedRead(f); } catch (e) { continue; }
      const lines = text.split('\n');
      const kept = lines.filter((ln) => !(kill.test(ln)));
      if (kept.length !== lines.length) {
        // collapse consecutive blank lines left by removed reference lines (keep single blank lines)
        const cleaned = kept.join('\n').replace(/\n{3,}/g, '\n\n');
        try { await this.app.vault.modify(f, cleaned); } catch (e) { /* ignore */ }
      }
    }
  }
  /* v2.11: create the 6 category (+ Standalone) subfolders under the lore root, sorted by category */
  async ensureLibFolders() {
    const root = normalizePath(this.settings.folderSetting || 'Lore');
    await this.ensureFolder(root);
    for (const g of ENTITY_GROUPS) {
      await this.ensureFolder(normalizePath(root + '/' + groupFolderName(g.name)));
    }
  }

  /* ========== v1.5 outline file engine ==========
     Each outline = Outline/<Title>.md; frontmatter stores linked targets and params, the body is a skeleton from the type template. */
  outlineRoot() { return normalizePath(this.settings.folderOutline || 'Outline'); }
  /* YAML frontmatter of an outline file (records what is linked) */
  outlineFrontmatter(o) {
    return [
      '---',
      'nws_id: ' + o.id,
      'nws_title: ' + JSON.stringify(String(o.title || '')),
      'nws_type: ' + String(o.type || 'Chapter'),
      'nws_tags: [' + (o.tags || []).map((t) => JSON.stringify(String(t))).join(', ') + ']',
      'nws_color: ' + ((o.color == null ? 3 : o.color) % 6),
      'nws_bindings: ' + JSON.stringify(o.bindings || []),
      'nws_created: ' + (o.created || Date.now()),
      'nws_desc: ' + JSON.stringify(String(o.desc || '')),
      '---'
    ].join('\n');
  }
  /* Outline template body skeleton (generated on creation, includes a linked-targets section) */
  outlineTemplateBody(o) {
    const fields = outlineTemplateFields(o.type);
    let body = '\n# ' + String(o.title || '') + '\n\n';
    body += '## Linked Items\n\n';
    const binds = o.bindings || [];
    if (binds.length) binds.forEach((b) => { body += '- ' + (b.kind === 'chapter' ? '📄' : b.kind === 'entity' ? '🔗' : '📋') + ' ' + String(b.name || b.id) + '\n'; });
    else body += '(Not linked · click "🔗 Link" in the Studio outline panel to link chapters / lore)\n';
    body += '\n## Content\n\n';
    fields.forEach((f) => {
      const hint = OUTLINE_FIELD_HINTS[f];
      body += '### ' + f + '\n\n' + (hint ? '<!-- Fill-in guide:' + hint + ' -->\n\n' : '');
    });
    if (o.desc) body += '\n## Notes\n\n' + o.desc + '\n';
    return body;
  }
  /* Create or update an outline file; on update keep the user's handwritten body and only replace frontmatter */
  async writeOutlineFile(o, isNew) {
    await this.ensureFolder(this.outlineRoot());
    let fname = this.safeFileName(o.title) + '.md';
    let path = normalizePath(this.outlineRoot() + '/' + fname);
    // on creation, if a same-name file already belongs to another outline, add a short id suffix to avoid overwriting its body
    if (isNew && !o.file) {
      const clash = this.app.vault.getAbstractFileByPath(path);
      if (clash instanceof TFile) {
        fname = this.safeFileName(o.title) + '-' + o.id.slice(-4) + '.md';
        path = normalizePath(this.outlineRoot() + '/' + fname);
      }
    }
    if (o.file && o.file !== path) {
      const old = this.app.vault.getAbstractFileByPath(o.file);
      if (old instanceof TFile) { try { await this.app.vault.rename(old, path); } catch (e) { /* conflict fallback */ } }
    }
    let file = this.app.vault.getAbstractFileByPath(path);
    const fm = this.outlineFrontmatter(o);
    if (file instanceof TFile) {
      const old = await this.app.vault.cachedRead(file);
      let body = old.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
      body = this.syncOutlineSections(o, body, isNew);
      const next = fm + '\n' + body;
      if (next !== old) await this.app.vault.modify(file, next);
    } else {
      file = await this.app.vault.create(path, fm + this.outlineTemplateBody(o));
    }
    o.file = path;
    return file;
  }
  /* v2.6: sync the two managed sections "Linked Items / Notes" into the outline file body —
     every link/unlink or note edit in the panel is written to the corresponding md automatically; the user's other handwritten content (title, template fields etc.) is kept as-is.
     regenTpl=true (on type change) also rebuilds the "## Content" template skeleton section from the new type. */
  syncOutlineSections(o, body, regenTpl) {
    const secRe = (title) => new RegExp('\n## ' + title + '\n[\\s\\S]*?(?=\n## |\n# |$)');
    /* Linked items */
    const bindLines = (o.bindings || []).map((b) => '- ' + (b.kind === 'chapter' ? '📄' : b.kind === 'entity' ? '🔗' : '📋') + ' ' + String(b.name || b.id) + '\n').join('');
    const bindBlock = '\n## Linked Items\n\n' + (bindLines || '(Not linked · click "🔗 Link" in the Studio outline panel to link chapters / lore)\n');
    if (secRe('Linked Items').test(body)) body = body.replace(secRe('Linked Items'), bindBlock);
    else body += bindBlock;
    /* Notes (= the panel description) */
    const descBlock = (o.desc && String(o.desc).trim()) ? '\n## Notes\n\n' + String(o.desc).trim() + '\n' : '';
    if (secRe('Notes').test(body)) body = body.replace(secRe('Notes'), descBlock);
    else if (descBlock) body += descBlock;
    /* type change → rebuild the template content section */
    if (regenTpl) {
      let tpl = '\n## Content\n\n';
      outlineTemplateFields(o.type).forEach((f) => {
        const hint = OUTLINE_FIELD_HINTS[f];
        tpl += '### ' + f + '\n\n' + (hint ? '<!-- Fill-in guide:' + hint + ' -->\n\n' : '');
      });
      if (secRe('Content').test(body)) body = body.replace(secRe('Content'), tpl);
      else body += tpl;
    }
    return body;
  }
  /* Parse outline metadata from file frontmatter */
  async readOutlineMeta(file) {
    let t = '';
    try { t = await this.app.vault.cachedRead(file); } catch (e) { return null; }
    const m = t.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return null;
    const fm = m[1];
    const get = (k) => { const r = new RegExp('^' + k + ':\\s*(.*)$', 'm').exec(fm); return r ? r[1].trim() : null; };
    const id = get('nws_id');
    if (!id) return null;
    const PJ = (s, fb) => { try { return JSON.parse(s); } catch (e) { return fb; } };
    return {
      id, type: get('nws_type') || 'Chapter',
      tags: PJ(get('nws_tags') || '[]', []),
      color: parseInt(get('nws_color'), 10),
      bindings: PJ(get('nws_bindings') || '[]', []),
      created: parseInt(get('nws_created'), 10) || Date.now(),
      desc: PJ(get('nws_desc') || '""', ''),
      file: file.path,
      title: PJ(get('nws_title') || '""', '') || file.basename
    };
  }
  /* Outline files → memory index */
  async syncOutlineFiles() {
    const root = this.outlineRoot();
    const live = Object.create(null);
    const files = this.app.vault.getMarkdownFiles().filter((f) => f.path.indexOf(root + '/') === 0);
    let changed = false;
    for (const f of files) {
      const meta = await this.readOutlineMeta(f);
      if (!meta) continue;
      live[f.path] = 1;
      let o = this.data.outlines.find((x) => x.id === meta.id);
      if (!o) {
        o = { id: meta.id, title: meta.title, type: meta.type, color: meta.color, tags: meta.tags, bindings: meta.bindings, created: meta.created, desc: meta.desc, file: f.path };
        this.data.outlines.push(o);
        changed = true;
      } else {
        const oldTitle = o.title;
        o.title = meta.title; o.type = meta.type; o.color = isNaN(meta.color) ? o.color : meta.color;
        o.tags = meta.tags; o.bindings = meta.bindings; o.desc = meta.desc; o.file = f.path;
        if (oldTitle !== meta.title) changed = true;
      }
    }
    const before = this.data.outlines.length;
    this.data.outlines = this.data.outlines.filter((o) => !o.file || live[o.file]);
    if (this.data.outlines.length !== before) changed = true;
    if (changed) await this.saveNow();
  }
  /* Memory → outline files: legacy data / new entries materialized to md */
  async ensureOutlineFiles() {
    let changed = false;
    for (const o of this.data.outlines) {
      if (!o.file || !this.app.vault.getAbstractFileByPath(o.file)) {
        await this.writeOutlineFile(o, true);
        changed = true;
      }
    }
    if (changed) await this.saveNow();
  }
  async openOutlineFile(id) {
    const o = this.outlineById(id);
    if (!o) return;
    await this.ensureOutlineFiles();
    const f = this.app.vault.getAbstractFileByPath(o.file);
    if (f instanceof TFile) await this.app.workspace.getLeaf('tab').openFile(f);
  }

  /* ---------- Scan + stats ---------- */
  async rescan(refresh) {
    await this.syncFilesToIndex(); // lore files edited/deleted directly in Obsidian → sync back to the index
    await this.syncOutlineFiles(); // outline files → index
    const body = normalizePath(this.settings.folderBody || 'Manuscript');
    const prefix = body + '/';
    const chapters = [];
    const wordCache = Object.create(null);
    const perEntity = Object.create(null);
    const perChapter = Object.create(null);
    this.data.entities.forEach((e) => { perEntity[e.id] = { entity: e, total: 0, chapters: Object.create(null), first: '', last: '' }; });

    for (const f of this.app.vault.getMarkdownFiles()) {
      let text = '';
      try { text = await this.app.vault.cachedRead(f); } catch (e) { text = ''; }
      wordCache[f.path] = countWords(text);
      if (f.path !== normalizePath(this.settings.inspirationFile) && f.path.indexOf(prefix) === 0) {
        const rel = f.path.slice(prefix.length);
        const parts = rel.split('/');
        const volume = parts.length > 1 ? parts[0] : '(Unfiled)';
        const meta = this.data.chapters[f.path] || {};
        const ch = {
          path: f.path, file: f, title: f.basename, volume, words: wordCache[f.path],
          status: meta.status == null ? (wordCache[f.path] > 0 ? 1 : 0) : meta.status, order: meta.order || 0
        };
        chapters.push(ch);
        const chMap = Object.create(null);
        this.data.entities.forEach((e) => {
          const n = countTerms(text, [e.name].concat(e.aliases || []));
          if (n > 0) {
            chMap[e.id] = n;
            const pe = perEntity[e.id];
            pe.total += n;
            pe.chapters[f.path] = n;
            if (!pe.first) pe.first = ch.title;
            pe.last = ch.title;
          }
        });
        perChapter[f.path] = chMap;
      }
    }
    chapters.sort((a, b) => a.volume.localeCompare(b.volume, 'zh') || a.order - b.order || a.title.localeCompare(b.title, 'zh'));
    this.wordCache = wordCache;
    this.stats = { perEntity, perChapter, chapters, totalWords: chapters.reduce((s, c) => s + c.words, 0) };
    this.entityVersion++;
    /* v2.9.1: after stats complete → auto-refresh the "Appears In" tables in lore notes */
    this.scheduleAppearSync();
    if (refresh) this.refreshViews();
  }
  countFile(file) { return this.wordCache[file.path] || 0; }
  allChapters() { return this.stats.chapters.slice(); }
  aggregate() { return this.stats; }
  metaOf(path) { return this.data.chapters[path] || {}; }
  async setMeta(path, patch) {
    this.data.chapters[path] = Object.assign({}, this.metaOf(path), patch);
    await this.saveNow(); this.refreshViews();
  }
  /* ========== v2.5: per-chapter stats ========== */
  isChapterPath(path) {
    const body = normalizePath(this.settings.folderBody || 'Manuscript') + '/';
    return String(path).indexOf(body) === 0;
  }
  chapterTiming(path) {
    const m = this.metaOf(path);
    return Object.assign({ open: 0, active: 0, focus: 0, written: 0 }, (m && m.timing) || {});
  }
  /* This chapter's lore by classification: groups = by category, libs = by library, top = 10 most frequent */
  chapterEntityStats(path) {
    const chMap = (this.stats && this.stats.perChapter && this.stats.perChapter[path]) || {};
    const groups = Object.create(null), libs = Object.create(null), list = [];
    Object.keys(chMap).forEach((id) => {
      const e = this.entityById(id); if (!e) return;
      const n = chMap[id];
      const g = e.group || groupOfLib(e.type) || 'Standalone';
      const G = groups[g] || (groups[g] = { name: g, emoji: groupEmoji(g), total: 0, libs: Object.create(null) });
      G.total += n;
      const lib = e.type || 'Uncategorized';
      G.libs[lib] = (G.libs[lib] || 0) + n;
      libs[lib] = (libs[lib] || 0) + n;
      list.push({ e, n });
    });
    list.sort((a, b) => b.n - a.n);
    return {
      total: list.reduce((s, it) => s + it.n, 0),
      groups: Object.keys(groups).map((g) => {
        const G = groups[g];
        G.libArr = Object.keys(G.libs).map((k) => ({ name: k, total: G.libs[k] })).sort((a, b) => b.total - a.total);
        return G;
      }).sort((a, b) => b.total - a.total),
      libs: Object.keys(libs).map((k) => ({ name: k, emoji: typeEmoji(k), total: libs[k] })).sort((a, b) => b.total - a.total),
      top: list.slice(0, 10)
    };
  }

  /* ========== v2.1: word data / progress bar / Pomodoro / focus ========== */
  /* Chapters word goal: per-chapter setting first, otherwise the global default */
  targetOf(path) {
    const m = this.metaOf(path);
    const t = Number(m && m.target);
    return (t && t > 0) ? t : (Number(this.settings.chapterTarget) || DEFAULT_CHAPTER_TARGET);
  }
  async setActiveChapterTarget() {
    const f = this.app.workspace.getActiveFile();
    if (!f) { new Notice('Open a chapter first'); return; }
    new InputModal(this.app, 'Chapter word goal (0 = use global default ' + (this.settings.chapterTarget || DEFAULT_CHAPTER_TARGET) + ')',
      String(this.targetOf(f.path)), async (v) => {
        const n = parseInt(v, 10);
        if (isNaN(n) || n < 0) { new Notice('Enter a valid number'); return; }
        await this.setMeta(f.path, { target: n });
        await this.rescan(true);
        new Notice(n > 0 ? 'Chapter goal: ' + fmt(n) + ' words' : 'Chapter goal now follows the global default');
      }).open();
  }
  /* Record word-count deltas (called by CM6 on body changes), accumulated per day; v2.13 also tracks hour buckets / weekday-weekend */
  recordTyping(path, deltaWords) {
    if (!deltaWords || deltaWords <= 0) return;
    const key = dateKey();
    const d = this.data.daily[key] || (this.data.daily[key] = { words: 0, secs: 0, focus: 0, sessions: 0 });
    d.words += deltaWords;
    /* v2.13: time distribution tracking — hour buckets + weekday/weekend */
    const now0 = new Date();
    if (!Array.isArray(d.hours) || d.hours.length !== 24) d.hours = Object.assign(Array(24).fill(0), d.hours || {});
    d.hours[now0.getHours()] += deltaWords;
    const dow = now0.getDay();
    if (dow === 0 || dow === 6) d.we = (d.we || 0) + deltaWords; else d.wk = (d.wk || 0) + deltaWords;
    /* v2.5: total input for this chapter (used for per-chapter pace) */
    const cm = this.data.chapters[path] = this.data.chapters[path] || {};
    const tm = cm.timing = Object.assign({ open: 0, active: 0, focus: 0, written: 0 }, cm.timing || {});
    tm.written += deltaWords;
    this._lastTypePath = path;
    /* Writing time: gaps <60s since the last keystroke count as continuous writing and are accumulated */
    const now = Date.now();
    if (this._lastTypeAt && now - this._lastTypeAt < 60000) d.secs += Math.min(60, (now - this._lastTypeAt) / 1000);
    this._lastTypeAt = now;
    /* Live pace samples */
    this.paceSamples.push({ t: now, w: deltaWords });
    if (this.paceSamples.length > 400) this.paceSamples.splice(0, this.paceSamples.length - 400);
    this.scheduleSave();
    this.refreshProgressBar();
    this.refreshFocusHUD();
    if (this.statsViewOpen()) this.scheduleStatsRefresh();
  }
  /* v2.13: deleted word count (efficiency: delete/edit ratio) */
  recordDeletion(n) {
    if (!n || n <= 0) return;
    const key = dateKey();
    const d = this.data.daily[key] || (this.data.daily[key] = { words: 0, secs: 0, focus: 0, sessions: 0 });
    d.del = (d.del || 0) + n;
    this.scheduleSave();
  }
  /* Live pace: words in the last N seconds / seconds → words per minute */
  pacePerMinute() {
    const win = (Number(this.settings.paceWindow) || 60) * 1000;
    const now = Date.now();
    const recent = this.paceSamples.filter((s) => now - s.t <= win);
    const words = recent.reduce((a, s) => a + s.w, 0);
    return Math.round(words / ((Number(this.settings.paceWindow) || 60) / 60));
  }
  statsViewOpen() { return this.app.workspace.getLeavesOfType(VIEW_STATS).length > 0; }
  scheduleStatsRefresh() {
    if (this._statsTimer) return;
    this._statsTimer = setTimeout(() => { this._statsTimer = null; this.refreshViews(); }, 1500);
  }
  /* Today's data (includes live accumulation during focus sessions) */
  todayData() {
    const k = dateKey();
    /* Focus time is written to daily[k].focus directly by the 1-second tick; read it here to avoid double accumulation */
    return Object.assign({ words: 0, secs: 0, focus: 0, sessions: 0 }, this.data.daily[k] || {});
  }
  focusElapsed() {
    const s = this.focusState;
    if (!s.active) return 0;
    return s.seconds || 0; // accumulated by the 1-second timer; paused time doesn't add
  }
  /* 1-second tick: refresh live pace on the progress bar + persist focus timing + v2.5 per-chapter timing */
  tickLive() {
    this.refreshProgressBar();
    this.refreshFocusHUD();
    /* v2.5: if the active file is a chapter → accumulate its open time; keystrokes within 60s count as writing time; during focus timing it counts as focus time.
       Idle time = open time − writing time (computed at display time, never double-recorded). */
    try {
      const f = this.app.workspace.getActiveFile();
      if (f && this.isChapterPath(f.path)) {
        const cm = this.data.chapters[f.path] = this.data.chapters[f.path] || {};
        const tm = cm.timing = Object.assign({ open: 0, active: 0, focus: 0, written: 0 }, cm.timing || {});
        const now = Date.now();
        tm.open += 1;
        if (this._lastTypeAt && now - this._lastTypeAt < 60000 && this._lastTypePath === f.path) tm.active += 1;
        if (this.focusState.active && this.focusState.mode === 'focus') tm.focus += 1;
        if (!this._timingSavedAt || now - this._timingSavedAt > 15000) { this._timingSavedAt = now; this.scheduleSave(); }
      }
    } catch (e) { /* ignore */ }
    if (this.focusState.active && this.focusState.mode === 'focus' && this.statsViewOpen()) this.scheduleStatsRefresh();
  }

  /* ---------- Top floating gradient progress bar ---------- */
  buildProgressBar() {
    let b = document.getElementById('nws-progress');
    if (!b) { b = el('div'); b.id = 'nws-progress'; document.body.appendChild(b); }
    this.barEl = b;
    b.innerHTML = '<div class="nws-bar-track"><div class="nws-bar-fill"></div></div>' +
      '<div class="nws-bar-meta"><span class="nws-bar-name"></span><span class="nws-bar-nums"></span></div>';
  }
  refreshProgressBar() {
    const b = this.barEl;
    if (!b) return;
    const f = this.app.workspace.getActiveFile();
    const bodyDir = normalizePath(this.settings.folderBody || 'Manuscript');
    if (!f || f.extension !== 'md' || f.path.indexOf(bodyDir + '/') !== 0 || !this.settings.showProgressBar) {
      b.style.display = 'none'; return;
    }
    let current;
    if (this.liveText != null && this._livePath === f.path) {
      current = countWords(this.liveText);
    } else if (this.wordCache[f.path] != null) {
      current = this.wordCache[f.path];
    } else {
      /* First open, no cache yet: read once asynchronously then refresh */
      this.app.vault.cachedRead(f).then((t) => { this.wordCache[f.path] = countWords(t); this.refreshProgressBar(); }).catch(() => {});
      current = 0;
    }
    const target = this.targetOf(f.path);
    const pct = Math.min(100, target > 0 ? Math.round(current / target * 100) : 0);
    const left = Math.max(0, target - current);
    const pace = this.pacePerMinute();
    b.style.display = '';
    b.dataset.pct = String(pct);
    b.querySelector('.nws-bar-fill').style.width = pct + '%';
    b.querySelector('.nws-bar-name').textContent = '✍️ ' + f.basename;
    b.querySelector('.nws-bar-nums').textContent = fmt(current) + ' / ' + fmt(target) + ' words · ' + pct + '% · ' + fmt(left) +
      ' · pace ' + pace + ' wpm' + (this.focusState.active ? ' · ⏱ ' + fmtDur(this.focusElapsed()) : '');
  }

  /* ---------- v2.11: focus-mode live stats HUD (bottom right) ---------- */
  buildFocusHUD() {
    let h = document.getElementById('nws-focus-hud');
    if (!h) { h = el('div'); h.id = 'nws-focus-hud'; document.body.appendChild(h); }
    this.hudEl = h;
    h.innerHTML =
      '<div class="nws-hud-hd">Live Writing</div>' +
      '<div class="nws-hud-row"><span>Typing speed</span><b data-k="pace">0</b></div>' +
      '<div class="nws-hud-row"><span>Writing time</span><b data-k="type">0s</b></div>' +
      '<div class="nws-hud-row"><span>Idle time</span><b data-k="idle">0s</b></div>' +
      '<div class="nws-hud-row"><span>Focus time</span><b data-k="focus">0s</b></div>' +
      '<div class="nws-hud-row"><span>Words written</span><b data-k="words">0 words</b></div>' +
      '<div class="nws-hud-row"><span>Completion</span><b data-k="pct">0%</b></div>';
    h.style.display = 'none';
  }
  /* Refreshed every second / on typing; shown only while focus mode is active */
  refreshFocusHUD() {
    const h = this.hudEl;
    if (!h) return;
    const s = this.focusState;
    if (!s || !s.active || s.mode !== 'focus') { h.style.display = 'none'; return; }
    h.style.display = '';
    const f = this.app.workspace.getActiveFile();
    /* Chapter word count (live text first → cache → async read) */
    let words = 0;
    if (f && f.extension === 'md') {
      if (this.liveText != null && this._livePath === f.path) words = countWords(this.liveText);
      else if (this.wordCache[f.path] != null) words = this.wordCache[f.path];
      else {
        this.app.vault.cachedRead(f).then((t) => { this.wordCache[f.path] = countWords(t); this.refreshFocusHUD(); }).catch(() => {});
      }
    }
    const target = f ? this.targetOf(f.path) : 0;
    const pct = Math.min(100, target > 0 ? Math.round(words / target * 100) : 0);
    /* Typing/idle time from the chapter timer: active = writing time, open-active = idle */
    const tm = f ? this.chapterTiming(f.path) : { open: 0, active: 0 };
    const idle = Math.max(0, (tm.open || 0) - (tm.active || 0));
    const set = (k, v) => { const n = h.querySelector('[data-k="' + k + '"]'); if (n) n.textContent = v; };
    set('pace', this.pacePerMinute() + ' wpm');
    set('type', fmtDur(tm.active || 0));
    set('idle', fmtDur(idle));
    set('focus', fmtDur(this.focusElapsed() || 0));
    set('words', fmt(words) + ' words');
    set('pct', pct + '%');
  }

  /* ---------- Focus wallpapers ---------- */
  clearFocusWallpaper() {
    document.body.classList.remove('nws-focus-on');
    document.body.style.removeProperty('--nws-focus-bg');
    const m = document.getElementById('nws-focus-mask'); if (m) m.remove();
  }
  applyFocusWallpaper(wallpaperId) {
    this.clearFocusWallpaper();
    const wp = FOCUS_WALLPAPERS.find((w) => w.id === wallpaperId) || FOCUS_WALLPAPERS[0];
    if (!wp.css) return;
    document.body.classList.add('nws-focus-on');
    document.body.style.setProperty('--nws-focus-bg', wp.css);
    let mask = document.getElementById('nws-focus-mask');
    if (!mask) { mask = el('div'); mask.id = 'nws-focus-mask'; document.body.appendChild(mask); }
    /* v2.8: adjustable overlay dimming — darker suppresses UI noise better */
    const dim = clamp(Number(this.settings.focusDim) || 0, 0, 0.9);
    mask.style.opacity = String(dim || 0.001);
  }

  /* ---------- v2.8 zen mode: fullscreen + hide sidebars + narrow the content column ---------- */
  enterFocusZen() {
    try {
      const ws = this.app.workspace;
      this._zenSaved = {
        left: !!(ws.leftSplit && ws.leftSplit.collapsed),
        right: !!(ws.rightSplit && ws.rightSplit.collapsed),
      };
      try { if (ws.leftSplit && !ws.leftSplit.collapsed) ws.leftSplit.collapse(); } catch (e) {}
      try { if (ws.rightSplit && !ws.rightSplit.collapsed) ws.rightSplit.collapse(); } catch (e) {}
    } catch (e) {}
    document.body.classList.add('nws-focus-zen');
    try {
      if (document.documentElement.requestFullscreen && !document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
      }
    } catch (e) {}
  }
  exitFocusZen() {
    document.body.classList.remove('nws-focus-zen');
    try {
      const ws = this.app.workspace;
      const sv = this._zenSaved || {};
      try { if (ws.leftSplit && sv.left === false && ws.leftSplit.collapsed) ws.leftSplit.expand(); } catch (e) {}
      try { if (ws.rightSplit && sv.right === false && ws.rightSplit.collapsed) ws.rightSplit.expand(); } catch (e) {}
      this._zenSaved = null;
      if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
    } catch (e) {}
  }

  /* ---------- v2.8 typing sound: one beep per keypress (25ms throttle against repeats)
       v2.11: muted by default + only sounds during focus/Pomodoro sessions; force=true for previewing in settings ---------- */
  playTypeSound(force) {
    if (!force && !(this.focusState && this.focusState.active)) return; // outside a focus session: always muted
    const id = this.settings.typeSound;
    if (!id || id === 'off') return;
    const now = Date.now();
    if (now - (this._lastTypeSnd || 0) < 25) return;
    this._lastTypeSnd = now;
    try {
      const ctx = this.ensureAudio(); if (!ctx) return;
      const vol = clamp(Number(this.settings.typeSoundVolume) || 0.35, 0, 1);
      const t = ctx.currentTime;
      if (id === 'type') {
        /* Typewriter: short crisp noise burst */
        const len = Math.floor(ctx.sampleRate * 0.02);
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
        const src = ctx.createBufferSource(); src.buffer = buf;
        const g = ctx.createGain(); g.gain.value = 0.5 * vol;
        const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 1500;
        src.connect(f); f.connect(g); g.connect(ctx.destination);
        src.start(t);
      } else {
        const o = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createBiquadFilter();
        if (id === 'key') { o.type = 'square'; o.frequency.value = 180 + Math.random() * 140; f.type = 'highpass'; f.frequency.value = 700; }
        else { o.type = 'sine'; o.frequency.value = 480 + Math.random() * 320; f.type = 'lowpass'; f.frequency.value = 1200; }
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.22 * vol, t + 0.004);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.035);
        o.connect(f); f.connect(g); g.connect(ctx.destination);
        o.start(t); o.stop(t + 0.05);
      }
    } catch (e) {}
  }

  /* ---------- Procedural sounds (Web Audio synthesis) ---------- */
  ensureAudio() {
    if (!this._audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this._audioCtx = new AC();
      this._audioNodes = [];
    }
    if (this._audioCtx.state === 'suspended') this._audioCtx.resume();
    return this._audioCtx;
  }
  stopSound() {
    if (this._audioNodes) { this._audioNodes.forEach((n) => { try { n.stop ? n.stop() : n.disconnect(); } catch (e) {} }); this._audioNodes = []; }
    if (this._soundTimer) { clearInterval(this._soundTimer); this._soundTimer = null; }
    if (this._audioCtx && this._audioCtx.state === 'running') { /* keep the ctx for reuse */ }
  }
  startSound(soundId) {
    this.stopSound();
    if (!soundId || soundId === 'off') return;
    const ctx = this.ensureAudio(); if (!ctx) return;
    const vol = Number(this.settings.focusSoundVolume) == null ? 0.3 : Number(this.settings.focusSoundVolume);
    const master = ctx.createGain(); master.gain.value = vol; master.connect(ctx.destination);
    this._audioNodes.push(master);
    const blip = (freq, dur, type, gain) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type || 'sine'; o.frequency.value = freq;
      g.gain.value = 0; o.connect(g); g.connect(master);
      const t = ctx.currentTime;
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain || 0.5, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.start(t); o.stop(t + dur + 0.02);
    };
    if (soundId === 'rain' || soundId === 'noise') {
      /* Looping white noise + low-pass filter, simulating rain */
      const len = ctx.sampleRate * 2;
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (soundId === 'rain' ? 0.6 : 0.35);
      const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
      const filt = ctx.createBiquadFilter(); filt.type = 'lowpass';
      filt.frequency.value = soundId === 'rain' ? 1800 : 900;
      src.connect(filt); filt.connect(master); src.start();
      this._audioNodes.push(src, filt);
      if (soundId === 'rain') this._soundTimer = setInterval(() => blip(600 + Math.random() * 400, 0.08, 'sine', 0.15), 700 + Math.random() * 500);
    } else if (soundId === 'drip') {
      this._soundTimer = setInterval(() => { blip(900 + Math.random() * 300, 0.12, 'sine', 0.5); setTimeout(() => blip(700, 0.09, 'sine', 0.3), 140); }, 1600);
    } else if (soundId === 'bubble') {
      this._soundTimer = setInterval(() => {
        const base = 200 + Math.random() * 120;
        for (let i = 0; i < 3; i++) setTimeout(() => blip(base + i * 40, 0.18, 'sine', 0.4), i * 130);
      }, 2200);
    }
    /* v2.8: keyboard sound moved into the typing sound (playTypeSound); ambient sound no longer includes it */
  }

  /* ---------- Focus session (shared timing for Focus Mode / Pomodoro) ---------- */
  startFocusSession(mode, seconds) {
    this.stopFocusSession(true);
    /* v2.13: Pomodoro start counting (completion stats) */
    if (mode === 'work') {
      const pm = this.data.pomo = this.data.pomo || { started: 0, completed: 0 };
      pm.started++;
    }
    this.focusState = {
      active: true, mode, seconds: 0, paused: false, left: seconds, startedAt: Date.now(),
      wallpaper: this.settings.focusWallpaper, sound: this.settings.focusSound,
    };
    this.applyFocusWallpaper(this.settings.focusWallpaper);
    if (mode === 'focus') {
      /* v2.8: Focus Mode enters zen state (fullscreen + hide sidebars); Pomodoro timing doesn't touch the UI */
      if (this.settings.focusFullscreen !== false) this.enterFocusZen();
      this.startSound(this.settings.focusSound);
      this.refreshFocusHUD();
    }
    this.focusState.timer = setInterval(() => {
      const s = this.focusState;
      if (!s.active || s.paused) return;
      s.seconds++; s.left--;
      /* Persist every second so quitting mid-session doesn't lose data */
      const k = dateKey();
      const d = this.data.daily[k] || (this.data.daily[k] = { words: 0, secs: 0, focus: 0, sessions: 0 });
      if (mode === 'focus') d.focus++;
      this.scheduleSave();
      if (s.left <= 0) { this.finishFocusSession(); return; }
      this.refreshProgressBar();
    }, 1000);
    new Notice('Started' + (mode === 'focus' ? 'Focus' : 'Timer') + ': ' + fmtDur(seconds));
  }
  pauseFocusSession() {
    const s = this.focusState;
    if (!s.active) return;
    if (!s.paused) { s.paused = true; this.stopSound(); }
    else { s.paused = false; if (s.mode === 'focus') this.startSound(s.sound); }
  }
  finishFocusSession() {
    const s = this.focusState;
    const mode = s.mode;
    /* v2.13: Pomodoro completion counter */
    if (mode === 'work') {
      const pm = this.data.pomo = this.data.pomo || { started: 0, completed: 0 };
      pm.completed++;
    }
    this.data.focusSessions.push({ ts: Date.now(), mode, seconds: s.seconds || 0 });
    if (this.data.focusSessions.length > 500) this.data.focusSessions.splice(0, this.data.focusSessions.length - 500);
    this.stopFocusSession(false);
    new Notice('⏰ Time\'s up! This session: ' + (mode === 'focus' ? 'Focus' : 'Timer') + 'End');
    try { const a = this.ensureAudio(); if (a) { const o = a.createOscillator(), g = a.createGain(); o.frequency.value = 880; g.gain.value = 0.3; o.connect(g); g.connect(a.destination); o.start(); o.stop(a.currentTime + 0.5); } } catch (e) {}
  }
  stopFocusSession(silent) {
    const s = this.focusState;
    if (s && s.timer) clearInterval(s.timer);
    /* Focus time is accumulated into daily[k].focus by the 1-second tick; no duplicate timing here */
    this.stopSound();
    this.exitFocusZen();
    this.clearFocusWallpaper();
    this.focusState = { active: false, wallpaper: '', sound: null, timer: null, endAt: 0, seconds: 0, paused: false, left: 0, mode: '' };
    if (this.hudEl) this.hudEl.style.display = 'none';
    this.scheduleSave();
    if (!silent) new Notice('Focus session ended');
    this.refreshProgressBar();
    this.refreshViews();
  }

  /* ---------- Volumes / chapters ---------- */
  async newChapter(volume) {
    const body = normalizePath(this.settings.folderBody || 'Manuscript');
    const inRoot = !volume || volume === '(Unfiled)';
    const dir = inRoot ? body : normalizePath(body + '/' + volume);
    try {
      await this.ensureFolder(dir);
      let name = 'Untitled Chapter', i = 1, path = normalizePath(dir + '/' + name + '.md');
      while (this.app.vault.getAbstractFileByPath(path)) { name = 'Untitled Chapter ' + (++i); path = normalizePath(dir + '/' + name + '.md'); }
      const f = await this.app.vault.create(path, '');
      await this.setMeta(path, { status: 0 });
      new Notice('Created empty chapter: ' + name);
      await this.app.workspace.getLeaf('tab').openFile(f);
    } catch (e) { new Notice('Creation failed: ' + ((e && e.message) || e)); }
  }
  async newVolume() {
    const body = normalizePath(this.settings.folderBody || 'Manuscript');
    let name = 'New Volume', i = 1;
    while (this.app.vault.getAbstractFileByPath(normalizePath(body + '/' + name))) { name = 'New Volume ' + (++i); }
    try { await this.ensureFolder(normalizePath(body + '/' + name)); await this.newChapter(name); }
    catch (e) { new Notice('Creation failed: ' + e.message); }
  }
  async renameVolume(volume, newName) {
    if (!newName || !newName.trim()) return;
    newName = newName.trim();
    if (newName === volume || newName === '(Unfiled)') return;
    const body = normalizePath(this.settings.folderBody || 'Manuscript');
    /* Unfiled → create a volume folder and move all md chapters under the manuscript root into it */
    if (volume === '(Unfiled)') {
      const to = normalizePath(body + '/' + newName);
      if (this.app.vault.getAbstractFileByPath(to)) { new Notice('Target volume name already exists'); return; }
      try {
        await this.ensureFolder(to);
        const migrated = Object.create(null);
        const roots = this.app.vault.getMarkdownFiles().filter((f) => {
          const rel = f.path.slice((body + '/').length);
          return f.path.indexOf(body + '/') === 0 && rel.indexOf('/') < 0;
        });
        for (const f of roots) {
          const np = normalizePath(to + '/' + f.name);
          await this.app.vault.rename(f, np);
          if (this.data.chapters[f.path]) { migrated[np] = this.data.chapters[f.path]; delete this.data.chapters[f.path]; }
        }
        Object.assign(this.data.chapters, migrated);
        await this.saveNow();
        await this.rescan(true);
        new Notice('Moved ' + roots.length + ' chapters into new volume: ' + newName);
      } catch (e) { new Notice('Operation failed: ' + (e && e.message || e)); }
      return;
    }
    const from = normalizePath(body + '/' + volume);
    const to = normalizePath(body + '/' + newName);
    const folder = this.app.vault.getAbstractFileByPath(from);
    if (!(folder instanceof TFolder)) { new Notice('Volume folder not found: ' + volume); return; }
    if (this.app.vault.getAbstractFileByPath(to)) { new Notice('Target volume name already exists'); return; }
    try {
      await this.app.vault.rename(folder, to);
      const migrated = Object.create(null);
      Object.keys(this.data.chapters).forEach((p) => { migrated[p.indexOf(from + '/') === 0 ? to + p.slice(from.length) : p] = this.data.chapters[p]; });
      this.data.chapters = migrated;
      const fixPath = (p) => (p && p.indexOf(from + '/') === 0 ? to + p.slice(from.length) : p);
      this.data.outlines.forEach((o) => (o.bindings || []).forEach((b) => { if (b.kind === 'chapter') b.id = fixPath(b.id); }));
      this.data.entities.forEach((e) => (e.bindings || []).forEach((b) => { if (b.kind === 'chapter') b.id = fixPath(b.id); }));
      await this.saveNow();
      await this.rescan(true);
      new Notice('Volume renamed to: ' + newName);
    } catch (e) { new Notice('Rename failed: ' + e.message); }
  }
  /* Move a chapter to another volume (newVolume is the volume name; '(Unfiled)' moves it back to the manuscript root) */
  async moveChapter(path, newVolume) {
    const body = normalizePath(this.settings.folderBody || 'Manuscript');
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) { new Notice('Chapter file not found'); return; }
    const curVolume = this.volumeOfPath(path);
    if (curVolume === newVolume) { new Notice('Already in this volume'); return; }
    const np = newVolume === '(Unfiled)'
      ? normalizePath(body + '/' + f.name)
      : normalizePath(body + '/' + newVolume + '/' + f.name);
    if (newVolume !== '(Unfiled)') {
      const dir = this.app.vault.getAbstractFileByPath(normalizePath(body + '/' + newVolume));
      if (!(dir instanceof TFolder)) { new Notice('Volume not found: ' + newVolume); return; }
    }
    if (this.app.vault.getAbstractFileByPath(np)) { new Notice('Target volume already has a file with this name: ' + f.name); return; }
    try {
      await this.app.vault.rename(f, np);
      /* Migrate chapter data (status / goal / timing) and linked references everywhere */
      if (this.data.chapters[path]) { this.data.chapters[np] = this.data.chapters[path]; delete this.data.chapters[path]; }
      const fix = (p) => (p === path ? np : p);
      this.data.outlines.forEach((o) => (o.bindings || []).forEach((b) => { if (b.kind === 'chapter') b.id = fix(b.id); }));
      this.data.entities.forEach((e) => (e.bindings || []).forEach((b) => { if (b.kind === 'chapter') b.id = fix(b.id); }));
      await this.saveNow();
      await this.rescan(true);
      new Notice('Moved "' + f.name.replace(/\.md$/, '') + '" → ' + newVolume);
    } catch (e) { new Notice('Move failed: ' + (e && e.message || e)); }
  }
  volumeOfPath(path) {
    const body = (this.settings.folderBody || 'Manuscript') + '/';
    if (path.indexOf(body) !== 0) return '—';
    const rel = path.slice(body.length);
    const i = rel.indexOf('/');
    return i < 0 ? '(Unfiled)' : rel.slice(0, i);
  }
  async openPath(path) {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) await this.app.workspace.getLeaf('tab').openFile(f);
    else if (f instanceof TFolder) {
      // reveal the folder in the left file tree (Obsidian 1.5+ supports revealInFolder)
      try {
        const fileExpl = this.app.workspace.getLeavesOfType('file-explorer')[0];
        if (fileExpl && fileExpl.view && fileExpl.view.revealInFolder) fileExpl.view.revealInFolder(f);
        else new Notice('Folder: ' + path);
      } catch (e) { new Notice('Folder: ' + path); }
    } else new Notice('Path does not exist: ' + path);
  }
  async openChapterByPath(path) {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) await this.app.workspace.getLeaf('tab').openFile(f);
  }

  /* ---------- Lore (entities) ---------- */
  typeColor(t) { const c = this.data.typeColors[t]; return Number.isInteger(c) ? c : 2; }
  entityById(id) { return this.data.entities.find((e) => e.id === id); }
  entityByName(name) { return this.data.entities.find((e) => e.name === name || (e.aliases || []).indexOf(name) >= 0); }
  async addEntity(name, type, group) {
    if (!name || !name.trim()) return null;
    const t = type || this.data.entityTypes[0] || 'Character';
    const g = group || groupOfLib(t);
    const e = { id: uid(), name: name.trim(), type: t, group: g, color: this.typeColor(t), aliases: [], desc: '', bindings: [], created: Date.now() };
    this.data.entities.push(e);
    await this.writeEntityFile(e, true);
    await this.saveNow(); await this.rescan(true);
    return e;
  }
  async classifySelection(text, type, group) {
    let e = this.entityByName(text);
    if (!e) e = await this.addEntity(text, type, group);
    if (e) {
      e.type = type; e.group = group || groupOfLib(type); e.color = this.typeColor(type);
      await this.writeEntityFile(e, false);
      await this.saveNow(); await this.rescan(true);
    }
    new Notice('Filed "' + text + '" → ' + (group || groupOfLib(type)) + ' / ' + type + '(lore folder synced)');
  }
  async recolorSelection(text, color) {
    let e = this.entityByName(text);
    if (!e) e = await this.addEntity(text, this.data.entityTypes[0] || 'Character');
    if (e) { e.color = color; await this.writeEntityFile(e, false); await this.saveNow(); this.entityVersion++; this.refreshViews(); }
    new Notice('"' + text + '"' + (color === -1 ? 'Set to no color (bold + underline)' : 'Highlight changed to ' + PALETTE_NAMES[color] + ''));
  }
  async updateEntity(id, patch) {
    const e = this.entityById(id); if (!e) return;
    Object.assign(e, patch);
    await this.writeEntityFile(e, false);
    await this.saveNow(); await this.rescan(true);
  }
  async deleteEntity(id) {
    const e = this.entityById(id);
    if (e && e.file) {
      const f = this.app.vault.getAbstractFileByPath(e.file);
      if (f instanceof TFile) { try { await this.app.vault.delete(f); } catch (err) { /* ignore */ } }
    }
    this.data.entities = this.data.entities.filter((x) => x.id !== id);
    await this.saveNow(); await this.rescan(true);
  }
  /* Open the lore source file */
  async openEntityFile(id) {
    const e = this.entityById(id); if (!e) return;
    if (!e.file || !this.app.vault.getAbstractFileByPath(e.file)) { await this.writeEntityFile(e, true); await this.saveNow(); }
    const f = this.app.vault.getAbstractFileByPath(e.file);
    if (f instanceof TFile) await this.app.workspace.getLeaf('tab').openFile(f);
  }

  /* ========== v1.3 plot CRUD ========== */
  plotById(id) { return this.data.plots.find((p) => p.id === id); }
  async addPlot(fields) {
    const p = {
      id: uid(),
      name: (fields.name || 'Untitled Plot').trim(),
      stages: fields.stages || {},
      roles: fields.roles || [],
      chapters: fields.chapters || [],
      tags: fields.tags || [],
      color: fields.color == null ? 3 : fields.color,
      note: fields.note || '',
      created: Date.now()
    };
    this.data.plots.push(p);
    await this.saveNow(); this.refreshViews();
    return p;
  }
  async updatePlot(id, patch) {
    const p = this.plotById(id); if (!p) return;
    Object.assign(p, patch);
    await this.saveNow(); this.refreshViews();
  }
  async deletePlot(id) {
    this.data.plots = this.data.plots.filter((p) => p.id !== id);
    // clean up dual-line links pointing to this plot
    this.data.lineNodes.forEach((n) => { n.bindings = (n.bindings || []).filter((b) => !(b.kind === 'plot' && b.id === id)); });
    await this.saveNow(); this.refreshViews();
  }
  /* Plot stage completion (number of filled stages) */
  plotStageDone(plot) { return PLOT_STAGES.filter((s) => (plot.stages && plot.stages[s.key] || '').trim()).length; }

  /* ========== Time/location/emotion multi-track CRUD (v2.4) ==========
     track: { id, name, axis:'time'|'space'|'emotion', view, bindings, order, created }
     node: { id, trackId, line(legacy), view, label, at, order, bindings, content, created }
     Visible axes settings.visibleAxes = any combination of ['time','space','emotion']. */
  trackById(id) { return (this.data.tracks || []).find((t) => t.id === id); }
  tracksOfAxis(axis) {
    return (this.data.tracks || []).filter((t) => t.axis === axis).sort((a, b) => (a.order - b.order) || (a.created - b.created));
  }
  /* Currently visible axes (independent toggles; compatible with legacy lineMode) */
  visibleAxes() {
    const va = this.settings.visibleAxes;
    if (Array.isArray(va) && va.length) return va;
    const m = this.settings.lineMode || 'both';
    return m === 'time' ? ['time'] : m === 'space' ? ['space'] : ['time', 'space'];
  }
  axisOn(axis) { return this.visibleAxes().indexOf(axis) >= 0; }
  toggleAxis(axis) {
    const cur = this.visibleAxes().slice();
    const i = cur.indexOf(axis);
    if (i >= 0) { if (cur.length > 1) cur.splice(i, 1); }   // keep at least one axis visible so the view never goes fully empty
    else cur.push(axis);
    this.settings.visibleAxes = cur;
    // ordered by TRACK_AXES for stable rendering
    this.settings.visibleAxes = TRACK_AXES.map((a) => a.key).filter((k) => cur.indexOf(k) >= 0);
  }
  visibleTracks() {
    const axes = this.visibleAxes();
    return (this.data.tracks || []).filter((t) => axes.indexOf(t.axis) >= 0)
      .sort((a, b) => (a.axis === b.axis ? (a.order - b.order) : (TRACK_AXES.findIndex((x) => x.key === a.axis) - TRACK_AXES.findIndex((x) => x.key === b.axis))) || (a.created - b.created));
  }
  async addTrack(fields) {
    const peers = this.tracksOfAxis(fields.axis);
    const t = {
      id: uid(), name: (fields.name || trackAxisDef(fields.axis).name).trim(),
      axis: fields.axis, view: fields.view || 'event',
      bindings: fields.bindings || [],
      order: peers.length ? Math.max.apply(null, peers.map((x) => x.order)) + 1 : 0,
      created: Date.now()
    };
    this.data.tracks.push(t);
    await this.saveNow(); this.refreshViews();
    return t;
  }
  async updateTrack(id, patch) {
    const t = this.trackById(id); if (!t) return;
    Object.assign(t, patch);
    /* When the view changes, sync every node's view on this track */
    if (patch.view) (this.data.lineNodes || []).forEach((n) => { if (n.trackId === id) n.view = patch.view; });
    await this.saveNow(); this.refreshViews();
  }
  async deleteTrack(id) {
    this.data.tracks = (this.data.tracks || []).filter((t) => t.id !== id);
    this.data.lineNodes = (this.data.lineNodes || []).filter((n) => n.trackId !== id);
    await this.saveNow(); this.refreshViews();
  }
  async moveTrack(id, dir) {
    const t = this.trackById(id); if (!t) return;
    const list = this.tracksOfAxis(t.axis);
    const i = list.findIndex((x) => x.id === id), j = i + dir;
    if (j < 0 || j >= list.length) return;
    const a = t.order, b = list[j].order; t.order = b; list[j].order = a;
    await this.saveNow(); this.refreshViews();
  }

  lineNodeById(id) { return (this.data.lineNodes || []).find((n) => n.id === id); }
  nodesOfLine(line) {
    /* Compatibility: line can be a trackId or legacy 'time'/'space' */
    let trackId = line;
    if (line === 'time') trackId = 'trk_time';
    else if (line === 'space') trackId = 'trk_space';
    return (this.data.lineNodes || []).filter((n) => (n.trackId || (n.line === 'space' ? 'trk_space' : 'trk_time')) === trackId)
      .sort((a, b) => (a.order - b.order) || (a.created - b.created));
  }
  async addLineNode(line, fields) {
    const peers = this.nodesOfLine(line);
    let trackId = line;
    if (line === 'time') trackId = 'trk_time';
    else if (line === 'space') trackId = 'trk_space';
    const track = this.trackById(trackId);
    const vd = trackViewDef(fields.view || (track && track.view) || 'event');
    const n = {
      id: uid(), trackId, line: track ? track.axis : (line === 'space' ? 'space' : 'time'),
      view: fields.view || (track && track.view) || 'event',
      label: (fields.label || vd.node).trim(),
      at: fields.at || '',
      order: fields.order == null ? (peers.length ? Math.max.apply(null, peers.map((x) => x.order)) + 1 : 0) : fields.order,
      bindings: fields.bindings || [], content: fields.content || '', created: Date.now()
    };
    this.data.lineNodes.push(n);
    await this.saveNow(); this.refreshViews();
    return n;
  }
  async updateLineNode(id, patch) {
    const n = this.lineNodeById(id); if (!n) return;
    Object.assign(n, patch);
    await this.saveNow(); this.refreshViews();
  }
  async deleteLineNode(id) {
    this.data.lineNodes = (this.data.lineNodes || []).filter((n) => n.id !== id);
    await this.saveNow(); this.refreshViews();
  }
  async moveLineNode(id, dir) {
    const n = this.lineNodeById(id); if (!n) return;
    const list = this.nodesOfLine(n.trackId || n.line);
    const i = list.findIndex((x) => x.id === id), j = i + dir;
    if (j < 0 || j >= list.length) return;
    const a = n.order, b = list[j].order; n.order = b; list[j].order = a;
    await this.saveNow(); this.refreshViews();
  }
  /* Generate placeholder content text from the node's links (for 'Write based on linked items') */
  lineNodeContentHint(n) {
    const vd = trackViewDef(n.view || 'event');
    const parts = (n.bindings || []).map((b) => b.name || b.id);
    return parts.length ? 'Around ' + vd.node + ': ' + parts.join(', ') : '(No linked items; click "Link" to link characters / plots / clues / foreshadowing; view: ' + vd.name + ')';
  }

  /* ---------- Outline ---------- */
  outlineById(id) { return this.data.outlines.find((o) => o.id === id); }
  async addOutline(title, type) {
    if (!title || !title.trim()) return null;
    const o = { id: uid(), title: title.trim(), type: type || 'Chapter', desc: '', bindings: [], tags: [], color: 3, file: '', created: Date.now() };
    this.data.outlines.push(o);
    await this.writeOutlineFile(o, true);
    await this.saveNow(); this.refreshViews();
    return o;
  }
  async updateOutline(id, patch) {
    const o = this.outlineById(id); if (!o) return;
    const oldType = o.type;
    Object.assign(o, patch);
    await this.writeOutlineFile(o, oldType !== o.type); // rebuild the template skeleton section on type change
    await this.saveNow(); this.refreshViews();
  }
  async deleteOutline(id) {
    const o = this.outlineById(id);
    if (o && o.file) {
      const f = this.app.vault.getAbstractFileByPath(o.file);
      if (f instanceof TFile) { try { await this.app.vault.delete(f); } catch (e) { /* ignore */ } }
    }
    this.data.outlines = this.data.outlines.filter((x) => x.id !== id);
    await this.saveNow(); this.refreshViews();
  }
  /* Links: ownerKind='outline'|'entity'; target={kind:'chapter'|'entity'|'outline', id, name} */
  async toggleBinding(ownerKind, ownerId, target) {
    const owner = ownerKind === 'outline' ? this.outlineById(ownerId) : this.entityById(ownerId);
    if (!owner) return;
    owner.bindings = owner.bindings || [];
    const idx = owner.bindings.findIndex((b) => b.kind === target.kind && b.id === target.id);
    if (idx >= 0) owner.bindings.splice(idx, 1);
    else owner.bindings.push({ kind: target.kind, id: target.id, name: target.name || '' });
    // persist link params to the corresponding md file
    if (ownerKind === 'outline') await this.writeOutlineFile(owner, false);
    else await this.writeEntityFile(owner, false);
    await this.saveNow(); this.refreshViews();
  }

  /* Entity match ranges in the body */
  mentionRanges(text) {
    const res = [], seen = Object.create(null);
    const push = (from, to, entity) => { const k = from + ':' + to; if (seen[k]) return; seen[k] = 1; res.push({ from, to, entity }); };
    const findAll = (term, entity) => {
      if (!term) return;
      let idx = text.indexOf(term);
      while (idx >= 0) { push(idx, idx + term.length, entity); idx = text.indexOf(term, idx + term.length); }
    };
    if (this.settings.entityAliasMatch) this.data.entities.forEach((e) => (e.aliases || []).forEach((a) => findAll(a, e)));
    if (this.settings.entityNameMatch) this.data.entities.forEach((e) => findAll(e.name, e));
    return res;
  }

  /* ---------- Idea file engine (v10): each idea = Ideas/<Title>.md ----------
     frontmatter stores id/status/links/source; the body is the idea content itself (no boilerplate). */
  inspirationRoot() { return normalizePath(this.settings.folderInspiration || 'Idea'); }
  noteFrontmatter(n) {
    return [
      '---',
      'nws_id: ' + n.id,
      'nws_kind: idea',
      'nws_status: ' + String(n.status || 'Pending'),
      'nws_source: ' + JSON.stringify(String(n.sourcePath || '')),
      'nws_bindings: ' + JSON.stringify(n.bindings || []),
      'nws_created: ' + (n.created || Date.now()),
      '---'
    ].join('\n');
  }
  noteBody(n) { return '\n' + String(n.content || '') + '\n'; }
  /* Derive a stable file name from the idea content */
  noteFileName(n) {
    const raw = String(n.content || 'Idea').replace(/\s+/g, ' ').trim();
    return this.safeFileName(raw.slice(0, 24) || 'Idea');
  }
  /* Create or update an idea note; on update keep the user's body (status/links still go to frontmatter) */
  async writeNoteFile(n, isNew) {
    await this.ensureFolder(this.inspirationRoot());
    let path = n.file && this.app.vault.getAbstractFileByPath(n.file)
      ? n.file
      : normalizePath(this.inspirationRoot() + '/' + this.noteFileName(n) + '.md');
    // file name conflict (different ideas sharing the first 24 chars) → add a short id suffix
    const exists = this.app.vault.getAbstractFileByPath(path);
    if (exists instanceof TFile) {
      const other = (this.data.notes || []).find((x) => x.file === path && x.id !== n.id);
      if (other) path = normalizePath(this.inspirationRoot() + '/' + this.noteFileName(n) + '-' + n.id.slice(-4) + '.md');
    }
    let file = this.app.vault.getAbstractFileByPath(path);
    const fm = this.noteFrontmatter(n);
    if (file instanceof TFile) {
      const old = await this.app.vault.cachedRead(file);
      const body = old.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
      const newContent = fm + (body || this.noteBody(n));
      if (newContent !== old) await this.app.vault.modify(file, newContent);
    } else {
      file = await this.app.vault.create(path, fm + this.noteBody(n));
    }
    n.file = path;
    return file;
  }
  async readNoteMeta(file) {
    let t = '';
    try { t = await this.app.vault.cachedRead(file); } catch (e) { return null; }
    const m = t.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return null;
    const get = (k) => { const r = new RegExp('^' + k + ':\\s*(.*)$', 'm').exec(m[1]); return r ? r[1].trim() : null; };
    const id = get('nws_id');
    if (!id || get('nws_kind') !== 'idea') return null;
    const PJ = (s, fb) => { try { return JSON.parse(s); } catch (e) { return fb; } };
    const body = t.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
    return {
      id, file: file.path,
      content: body || PJ(get('nws_content') || '""', ''),
      status: get('nws_status') || 'Pending',
      sourcePath: PJ(get('nws_source') || '""', ''),
      bindings: PJ(get('nws_bindings') || '[]', []),
      created: parseInt(get('nws_created'), 10) || Date.now()
    };
  }
  /* Files → memory: scan the ideas folder */
  async syncNoteFiles() {
    const root = this.inspirationRoot();
    const files = this.app.vault.getMarkdownFiles().filter((f) => f.path.indexOf(root + '/') === 0);
    let changed = false;
    for (const f of files) {
      const meta = await this.readNoteMeta(f);
      if (!meta) continue;
      const n = (this.data.notes || []).find((x) => x.id === meta.id);
      if (n) {
        const before = JSON.stringify([n.content, n.status, n.bindings, n.sourcePath]);
        n.content = meta.content; n.status = meta.status; n.bindings = meta.bindings;
        n.sourcePath = meta.sourcePath; n.file = meta.file;
        if (before !== JSON.stringify([n.content, n.status, n.bindings, n.sourcePath])) changed = true;
      } else {
        this.data.notes.push(meta);
        changed = true;
      }
    }
    // idea file deleted → remove from index (only notes inside the ideas folder)
    const before = (this.data.notes || []).length;
    this.data.notes = (this.data.notes || []).filter((n) => {
      if (!n.file || n.file.indexOf(root + '/') !== 0) return true;      // entries outside this folder are kept
      return !!this.app.vault.getAbstractFileByPath(n.file);            // keep only if the file still exists
    });
    if ((this.data.notes || []).length !== before) changed = true;
    if (changed) await this.saveNow();
  }
  /* Memory → files: legacy ideas (no file) materialized to md */
  async ensureNoteFiles() {
    let changed = false;
    for (const n of (this.data.notes || [])) {
      if (!n.file || !this.app.vault.getAbstractFileByPath(n.file)) {
        await this.writeNoteFile(n, true);
        changed = true;
      }
    }
    if (changed) await this.saveNow();
  }
  /* Legacy Ideas.md: convert its "- xxx" lines into idea notes, then delete the file */
  async retireOldInspirationFile() {
    const f = normalizePath(this.settings.inspirationFile || 'Ideas.md');
    const old = this.app.vault.getAbstractFileByPath(f);
    if (!(old instanceof TFile)) return;
    let text = '';
    try { text = await this.app.vault.cachedRead(old); } catch (e) { return; }
    const lines = text.split('\n').map((s) => s.trim()).filter((s) => /^-\s+/.test(s) && !/auto-collect|type \[/.test(s));
    for (const line of lines) {
      const content = line.replace(/^-\s+/, '').split(/\s+·\s+(Source|Pending|Adopted)/)[0].trim();
      if (content && !this.data.notes.some((n) => n.content === content)) {
        const note = { id: uid(), content, sourcePath: '', created: Date.now(), status: 'Pending', bindings: [], file: '' };
        this.data.notes.push(note);
        await this.writeNoteFile(note, true);
      }
    }
    try { await this.app.vault.delete(old); } catch (e) { /* ignore */ }
    await this.saveNow();
  }

  /* ---------- Idea collection (right-click selection / [ ] auto, unified entry) ---------- */
  async captureInspiration(content, sourcePath, opts) {
    opts = opts || {};
    const clean = String(content).replace(/\s+/g, ' ').trim();
    const note = { id: uid(), content: clean, sourcePath: sourcePath || '', created: Date.now(), status: opts.status || 'Pending', bindings: opts.bindings || [], file: '' };
    await this.writeNoteFile(note, true);
    this.data.notes.unshift(note);
    await this.saveNow(); this.refreshViews();
    new Notice('Saved to idea note: ' + clean.slice(0, 18) + (clean.length > 18 ? '…' : ''));
    return note;
  }
  noteById(id) { return (this.data.notes || []).find((n) => n.id === id); }
  async updateNote(id, patch) {
    const n = this.noteById(id); if (!n) return;
    Object.assign(n, patch);
    await this.writeNoteFile(n, false);
    await this.saveNow(); this.refreshViews();
  }
  async deleteNote(id) {
    const n = this.noteById(id);
    if (n && n.file) {
      const f = this.app.vault.getAbstractFileByPath(n.file);
      if (f instanceof TFile) { try { await this.app.vault.delete(f); } catch (e) { /* ignore */ } }
    }
    this.data.notes = (this.data.notes || []).filter((x) => x.id !== id);
    await this.saveNow(); this.refreshViews();
  }
  /* Idea status: Pending → Adopted / Dropped */
  async setNoteStatus(id, status) { await this.updateNote(id, { status }); new Notice('Idea status: ' + status); }

  /* ---------- Views & commands ---------- */
  async activateView(type) {
    let leaf = this.app.workspace.getLeavesOfType(type)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false) || this.app.workspace.getLeaf('tab');
      await leaf.setViewState({ type, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
    if (leaf.view && leaf.view.render) leaf.view.render();
  }
  refreshViews() {
    [VIEW_CATALOG, VIEW_OUTLINE, VIEW_ENTITIES, VIEW_NOTES, VIEW_PLOTS, VIEW_LINES, VIEW_STATS, VIEW_GANTT, VIEW_RELEASE, VIEW_SCENES].forEach((vt) => {
      this.app.workspace.getLeavesOfType(vt).forEach((leaf) => { if (leaf.view && leaf.view.render) leaf.view.render(); });
    });
  }
  registerCommands() {
    const reg = (id, name, fn) => this.addCommand({ id, name, callback: () => fn() });
    reg('open-catalog', 'Open catalog (volumes & chapters)', () => this.activateView(VIEW_CATALOG));
    reg('open-body-catalog', 'Open manuscript catalog', () => this.activateView(VIEW_CATALOG));
    reg('open-outline', 'Open outline', () => this.activateView(VIEW_OUTLINE));
    reg('open-entities', 'Open lore library', () => this.activateView(VIEW_ENTITIES));
    reg('open-plots', 'Open plots', () => this.activateView(VIEW_PLOTS));
    reg('open-lines', 'Open time / location / emotion lines', () => this.activateView(VIEW_LINES));
    reg('new-plot', 'New plot', () => { new PlotModal(this.app, this, null).open(); });
    reg('find-replace', 'Find & replace (current file)', () => new FindReplaceModal(this.app, this).open());
    reg('open-notes', 'Open ideas', () => this.activateView(VIEW_NOTES));
    reg('new-chapter', 'New chapter (empty)', () => this.newChapter('(Unfiled)'));
    reg('new-volume', 'New volume', () => this.newVolume());
    reg('open-inspiration', 'Open ideas folder', () => this.openPath(this.inspirationRoot()));
    reg('sync-setting-files', 'Sync lore files (rebuild index from md)', async () => { await this.syncFilesToIndex(); await this.ensureEntityFiles(); await this.rescan(true); new Notice('Lore files synced'); });
    reg('sync-outline-files', 'Sync outline files (rebuild index from md)', async () => { await this.syncOutlineFiles(); await this.ensureOutlineFiles(); await this.refreshViews(); new Notice('Outline files synced'); });
    reg('sync-all-files', 'Sync all files (lore + outline)', async () => {
      await this.syncFilesToIndex(); await this.syncOutlineFiles();
      await this.ensureEntityFiles(); await this.ensureOutlineFiles();
      await this.rescan(true); new Notice('Lore and outline files synced');
    });
    reg('open-setting-root', 'Open lore folder', () => this.openPath(normalizePath(this.settings.folderSetting)));
    reg('open-outline-root', 'Open outline folder', () => this.openPath(normalizePath(this.settings.folderOutline)));
    /* v2.1 */
    reg('open-stats', 'Open data center (heatmap / word stats)', () => this.activateView(VIEW_STATS));
    reg('focus-mode', 'Focus mode (wallpaper + sounds + live pace)', () => new FocusModal(this.app, this, 'focus').open());
    reg('pomodoro', 'Pomodoro', () => new FocusModal(this.app, this, 'pomodoro').open());
    reg('set-chapter-target', 'Set this chapter\'s word goal', () => this.setActiveChapterTarget());
    reg('chapter-stats', 'This chapter\'s stats (goal / pace / focus / lore usage / Top 10)', () => {
      const f = this.app.workspace.getActiveFile();
      if (!f || !this.isChapterPath(f.path)) { new Notice('Open a chapter under the manuscript folder first'); return; }
      new ChapterStatsModal(this.app, this, f.path).open();
    });
    reg('move-chapter', 'Move the current chapter to another volume', () => {
      const f = this.app.workspace.getActiveFile();
      if (!f || !this.isChapterPath(f.path)) { new Notice('Open a chapter under the manuscript folder first'); return; }
      new ChapterMoveModal(this.app, this, f.path).open();
    });
    reg('open-annots', 'Open annotation list', () => this.activateView(VIEW_ANNOT));
    reg('add-annotation', 'Add annotation to selection', () => {
      const md = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!md || !md.editor) { new Notice('Select some text in the manuscript first'); return; }
      const ed = md.editor;
      const sel = ed.getSelection();
      if (!sel || !sel.trim()) { new Notice('Select some text first'); return; }
      let from = 0, to = 0;
      try { from = ed.posToOffset(ed.getCursor('from')); to = ed.posToOffset(ed.getCursor('to')); } catch (e) { /* ignore */ }
      new AnnotationModal(this.app, this, this.app.workspace.getActiveFile().path, sel.trim(), from, to).open();
    });
    reg('focus-toggle', 'Start / end focus', () => this.focusState.active ? this.stopFocusSession() : (new FocusModal(this.app, this, 'focus').open()));
    reg('sync-appearances', 'Refresh "Appears In" stats of lore notes now', async () => { await this.syncEntityAppearances(); new Notice('"Appears In" stats updated'); });
    /* v2.2: command-palette fallback for selection actions (usable when the context menu fails; can be bound to hotkeys) */
    const selCmd = (id, name, fn) => this.addCommand({
      id, name,
      editorCallback: (editor) => {
        const s = editor.getSelection ? editor.getSelection() : '';
        if (!s || !s.trim()) { new Notice('Select text in the manuscript first'); return; }
        fn(s.trim());
      }
    });
    selCmd('sel-to-inspiration', '[Selection] Save as idea', async (text) => {
      const file = this.app.workspace.getActiveFile();
      const note = await this.captureInspiration(text, file ? file.path : '');
      if (note) new InspirationEditModal(this.app, this, note).open();
    });
    QUICK_CLASSIFY.forEach((q) => selCmd('sel-to-' + q.type, '[Selection] Set as ' + q.type,
      (text) => this.classifySelection(text, q.type, q.group)));
    selCmd('sel-to-entity', '[Selection] Save as lore (pick category)', (text) => {
      new EntityCreateModal(this.app, this, null, null, text).open();
    });
    /* v1.0: planning & scenes */
    reg('open-gantt', 'Open Gantt chart', () => this.activateView(VIEW_GANTT));
    reg('open-release', 'Open release plan', () => this.activateView(VIEW_RELEASE));
    reg('open-scenes', 'Open story scenes', () => this.activateView(VIEW_SCENES));
    reg('new-gantt-task', 'New Gantt task', () => new GanttTaskModal(this.app, this, null).open());
    reg('new-release', 'New release item', () => new ReleaseModal(this.app, this, null).open());
    reg('new-scene', 'New story scene', () => new SceneCardModal(this.app, this, null).open());
    reg('scene-presets', 'Writing scenes (presets & quick switch)', () => new ScenePresetModal(this.app, this).open());
    reg('save-current-scene', 'Save current setup as scene preset', () => new InputModal(this.app, 'Save current setup', 'e.g. Rainy Night Draft', async (v) => { if (v.trim()) { await this.saveScenePreset(v); new Notice('Scene preset saved: ' + v.trim()); } }).open());
  }

  /* ---------- Context-menu selection classification ---------- */
  registerContextMenu() {
    /* v2.7: event name fix — the Obsidian API is 'editor-menu' (older versions mistakenly used 'editor-context-menu', so the menu never appeared) */
    this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor) => {
      const sel = editor && editor.getSelection ? editor.getSelection() : '';
      if (!sel || !sel.trim()) return;
      const text = sel.trim();
      const p = this;
      menu.addSeparator();
      menu.addItem((item) => item.setTitle('💡 Save as idea').setIcon('lightbulb')
        .onClick(async () => {
          const file = p.app.workspace.getActiveFile();
          const note = await p.captureInspiration(text, file ? file.path : '');
          if (note) new InspirationEditModal(p.app, p, note).open();
        }));
      menu.addSeparator();
      /* v2.7: annotations on selected text (original untouched, hover display, managed in a table view) */
      menu.addItem((item) => item.setTitle('📝 Add annotation').setIcon('sticky-note')
        .onClick(() => {
          const file = p.app.workspace.getActiveFile();
          let from = 0, to = 0;
          try {
            from = editor.posToOffset(editor.getCursor('from'));
            to = editor.posToOffset(editor.getCursor('to'));
          } catch (e) { /* ignore */ }
          new AnnotationModal(p.app, p, file ? file.path : '', text, from, to).open();
        }));
      menu.addSeparator();
      QUICK_CLASSIFY.forEach((q) => {
        menu.addItem((item) => item.setTitle(q.emoji + ' Set as ' + q.type).setIcon('tag')
          .onClick(async () => { await p.classifySelection(text, q.type, q.group); }));
      });
      menu.addSeparator();
      /* Two-level classification by category → library (covers all types; unclassifiable goes to "Standalone") */
      ENTITY_GROUPS.forEach((g) => {
        menu.addItem((item) => {
          item.setTitle(g.emoji + ' Save as lore · ' + g.name + ' ▸').setIcon('tag');
          const sub = item.setSubmenu();
          libsOfGroup(g.name).forEach((l) => {
            const def = LIB_BY_NAME[l];
            sub.addItem((si) => si.setTitle((def ? def.emoji + ' ' : '') + l).onClick(async () => { await p.classifySelection(text, l, g.name); }));
          });
        });
      });
      menu.addItem((item) => item.setTitle('🖋️ Save as lore (pick category…)').setIcon('plus')
        .onClick(() => new EntityCreateModal(p.app, p, null, null, text).open()));
      try {
        menu.addItem((item) => {
          item.setTitle('🎨 Change highlight color').setIcon('palette');
          const sub = item.setSubmenu();
          PALETTE_NAMES.forEach((cn, ci) => sub.addItem((si) => si.setTitle(cn + '').onClick(async () => { await p.recolorSelection(text, ci); })));
        });
      } catch (e) {
        PALETTE_NAMES.forEach((cn, ci) => menu.addItem((item) => item.setTitle('🎨 Highlight as ' + cn + '').onClick(async () => { await p.recolorSelection(text, ci); })));
      }
    }));
  }

  /* ---------- Hover card ---------- */
  buildHover() {
    let h = document.getElementById('nws-hover');
    if (!h) { h = el('div'); h.id = 'nws-hover'; document.body.appendChild(h); }
    this.hoverEl = h;
    h.addEventListener('mouseenter', () => { clearTimeout(this.hoverTimer); clearTimeout(this.hoverHideTimer); });
    h.addEventListener('mouseleave', () => this.hideHover());
    h.addEventListener('click', (e) => {
      if (!this.hoverEntity) return;
      e.preventDefault(); e.stopPropagation();
      const ent = this.hoverEntity; this.hideHover();
      this.openEntityFile(ent.id);   // click to open the lore entry's full content directly
    });
  }
  /* Read a lore file content preview from cache (fills after stripping frontmatter / title / empty template fields) */
  entityContentPreview(entity) {
    if (!this._hoverCache) return '';
    return this._hoverCache[entity.id] || '';
  }
  async cacheEntityContent(entity) {
    if (!entity || !entity.file) return;
    if (!this._hoverCache) this._hoverCache = Object.create(null);
    if (!this._hoverCacheAt) this._hoverCacheAt = Object.create(null);
    const now = Date.now();
    if (this._hoverCache[entity.id] !== undefined && now - (this._hoverCacheAt[entity.id] || 0) < 3000) return;
    const f = this.app.vault.getAbstractFileByPath(entity.file);
    if (!(f instanceof TFile)) return;
    try {
      let t = fileBody(await this.app.vault.cachedRead(f));
      t = t.split('\n').filter((line) => {
        const s = line.trim();
        if (!s) return false;
        if (/^#\s/.test(s)) return false;                 // main heading
        if (/^>\s/.test(s)) return false;                 // template hint quote lines
        if (/^##\s+/.test(s)) return false;                // empty / field-name placeholders (shown only when content follows)
        return true;
      }).join(' ').replace(/[ \t]+/g, ' ').trim();
      this._hoverCache[entity.id] = t.slice(0, 280);
      this._hoverCacheAt[entity.id] = now;
    } catch (e) { this._hoverCache[entity.id] = ''; this._hoverCacheAt[entity.id] = now; }
  }
  showHover(entity, x, y) {
    if (!this.hoverEl) return;
    clearTimeout(this.hoverTimer); clearTimeout(this.hoverHideTimer);
    this.hoverEntity = entity;
    const h = this.hoverEl;
    const pe = this.stats.perEntity[entity.id] || { total: 0, first: '—' };
    const grp = entity.group || groupOfLib(entity.type);
    const render = (content) => {
      h.innerHTML =
        '<div class="h"><span>' + groupEmoji(grp) + '</span><span class="n">' + escapeHtml(entity.name) + '</span>' +
        '<span class="t">' + escapeHtml(grp) + ' · ' + escapeHtml(entity.type || '') + '</span></div>' +
        '<div class="d nws-hover-content">' + escapeHtml(content || entity.desc || '(no content yet)') + '</div>' +
        '<div class="f"><span>Aliases: ' + escapeHtml((entity.aliases || []).join(', ') || 'None') + '</span><span>Appears ' + pe.total + ' times</span></div>' +
        '<div class="f" style="border:none;padding-top:3px"><span>First: ' + escapeHtml(pe.first || '—') + '</span><span class="nws-lnk">Click to open · click a lore word in the body to jump →</span></div>';
    };
    render(this.entityContentPreview(entity));
    /* Fetch the file content preview asynchronously (refresh immediately if cached) */
    this.cacheEntityContent(entity).then(() => {
      if (this.hoverEntity && this.hoverEntity.id === entity.id) render(this.entityContentPreview(entity));
    });
    const fire = () => {
      h.style.display = 'block';
      const top = Math.min(y + 14, window.innerHeight - 210);
      h.style.left = Math.min(x + 12, window.innerWidth - 272) + 'px';
      h.style.top = Math.max(8, top) + 'px';
    };
    if (this.settings.hoverDelay) this.hoverTimer = setTimeout(fire, this.settings.hoverDelay);
    else fire();
  }
  hideHover() {
    clearTimeout(this.hoverTimer); clearTimeout(this.hoverHideTimer);
    this.hoverHideTimer = setTimeout(() => { if (this.hoverEl) this.hoverEl.style.display = 'none'; }, 220);
  }

  /* ---------- v2.7 annotations: annotate selected text, original untouched, hover display ---------- */
  buildAnnotHover() {
    let h = document.getElementById('nws-annot-hover');
    if (!h) { h = el('div'); h.id = 'nws-annot-hover'; document.body.appendChild(h); }
    this.annotHoverEl = h;
    h.addEventListener('mouseenter', () => clearTimeout(this.annotHideTimer));
    h.addEventListener('mouseleave', () => this.hideAnnotHover());
    h.addEventListener('click', (e) => {
      const del = e.target.closest('[data-adel]');
      if (del) { this.deleteAnnotation(del.dataset.adel); this.hideAnnotHover(); }
    });
  }
  showAnnotHover(a, x, y) {
    if (!this.annotHoverEl) return;
    clearTimeout(this.annotHideTimer);
    const h = this.annotHoverEl;
    const chap = (this.allChapters().find((c) => c.path === a.path) || {}).title || a.path.split('/').pop().replace(/\.md$/, '');
    h.innerHTML =
      '<div class="h">📝 Annotation · <span class="t">' + escapeHtml(chap) + '</span></div>' +
      '<div class="q">“' + escapeHtml(String(a.quote || '').slice(0, 60)) + (String(a.quote || '').length > 60 ? '…' : '') + '”</div>' +
      '<div class="d">' + escapeHtml(a.note || '(empty)') + '</div>' +
      '<div class="f"><span>' + new Date(a.created).toLocaleString() + '</span><span class="nws-lnk" data-adel="' + a.id + '">Delete annotation</span></div>';
    h.style.display = 'block';
    h.style.left = Math.min(x + 12, window.innerWidth - 280) + 'px';
    h.style.top = Math.min(y + 14, window.innerHeight - 200) + 'px';
  }
  hideAnnotHover() {
    clearTimeout(this.annotHideTimer);
    this.annotHideTimer = setTimeout(() => { if (this.annotHoverEl) this.annotHoverEl.style.display = 'none'; }, 220);
  }
  annotById(id) { return (this.data.annotations || []).find((a) => a.id === id); }
  async addAnnotation(path, quote, note, from, to) {
    const a = { id: uid(), path, quote, note: note || '', from: from || 0, to: to || 0, created: Date.now() };
    this.data.annotations.push(a);
    await this.saveNow();
    this.entityVersion++;   // trigger a decoration layer rebuild
    this.refreshViews();
    new Notice('Annotation added');
    return a;
  }
  async updateAnnotation(id, patch) { const a = this.annotById(id); if (!a) return; Object.assign(a, patch); await this.saveNow(); this.entityVersion++; this.refreshViews(); }
  async deleteAnnotation(id) {
    this.data.annotations = (this.data.annotations || []).filter((a) => a.id !== id);
    await this.saveNow(); this.entityVersion++; this.refreshViews();
    new Notice('Annotation deleted');
  }
  /* Jump back to an annotation's position from the catalog/panel: open the file, scroll and select the passage */
  async jumpToAnnotation(a) {
    await this.openChapterByPath(a.path);
    setTimeout(() => {
      try {
        const md = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!md || !md.editor) return;
        const ed = md.editor, doc = ed.getValue();
        let idx = doc.indexOf(a.quote, Math.max(0, Math.min(a.from || 0, doc.length)));
        if (idx < 0) idx = doc.indexOf(a.quote);
        if (idx < 0) { new Notice('The original text changed; this annotation\'s position can\'t be found'); return; }
        const from = ed.offsetToPos(idx), to = ed.offsetToPos(idx + a.quote.length);
        ed.setSelection(from, to);
        ed.scrollIntoView({ from: { line: from.line, ch: 0 }, to: { line: from.line, ch: 0 } }, true);
      } catch (e) { /* ignore */ }
    }, 350);
  }

  /* ---------- v2.9.1: auto-tracked "Appears In" in lore notes ---------- */
  /* Generate the "Appears In" table for a lore entry (chapters sorted by volume/order, links clickable) */
  appearSection(entityId) {
    const stats = this.stats || {};
    const pe = stats.perEntity ? stats.perEntity[entityId] : null;
    const e = pe ? pe.entity : this.entityById(entityId);
    if (!e) return '';
    const counts = pe ? pe.chapters : {};
    let total = 0, rows = [];
    for (const ch of (stats.chapters || [])) {
      const n = counts[ch.path];
      if (!n) continue;
      total += n;
      rows.push('| [[' + String(ch.path).replace(/\.md$/, '') + '\\|' + ch.title + ']] | ' + n + ' |');
    }
    const head = '## 📍 Appears In (auto-tracked · ' + total + ' times · ' + rows.length + ' chapters · click a chapter name to jump)\n\n'
      + '| Chapter | Appearances |\n| --- | --- |\n';
    return NWS_APPEAR_MARK + '\n' + head + (rows.length ? rows.join('\n') : '| — | No appearances yet |') + '\n';
  }
  /* Write the "Appears In" table into every lore note (replace content after the marker if present; otherwise append at the end) */
  async syncEntityAppearances() {
    if (this.settings.appearSync === false) return;
    try {
      if (!this.stats || !this.stats.chapters) return;
      for (const e of this.data.entities) {
        if (!e.file) continue;
        const f = this.app.vault.getAbstractFileByPath(e.file);
        if (!(f instanceof TFile)) continue;
        let text = '';
        try { text = await this.app.vault.cachedRead(f); } catch (err) { continue; }
        const sec = this.appearSection(e.id);
        if (!sec) continue;
        const idx = text.indexOf(NWS_APPEAR_MARK);
        const base = idx >= 0 ? text.slice(0, idx).replace(/\s+$/, '') : text.replace(/\s+$/, '');
        const newContent = base + '\n\n' + sec;
        if (newContent !== text) await this.app.vault.modify(f, newContent);
      }
    } catch (err) { console.error('[Novel Writing] Failed to sync "Appears In" stats:', err); }
  }

  /* ---------- CM6 body decoration layer ---------- */
  buildMarkExtension() {
    const plugin = this;
    const nwsMark = ViewPlugin.fromClass(class {
      constructor(view) {
        this.view = view;
        this.version = -1;
        this.mentions = [];
        this.decorations = this.build();
        this._move = (e) => this.onMove(e);
        this._leave = () => plugin.hideHover();
        this._down = (e) => { this._downX = e.clientX; this._downY = e.clientY; };
        this._click = (e) => this.onClick(e);
        view.dom.addEventListener('mousemove', this._move);
        view.dom.addEventListener('mouseleave', this._leave);
        view.dom.addEventListener('mousedown', this._down);
        view.dom.addEventListener('click', this._click);
      }
      /* v3.0: click a lore word in the body → open its lore note directly
         Single-click jumps by default; drag-selection (mousedown→click movement >4px) doesn't trigger, to avoid interrupting editing.
         With entityClickJump=false it falls back to Ctrl/Cmd+click only. */
      onClick(e) {
        const moved = Math.abs(e.clientX - (this._downX ?? e.clientX)) + Math.abs(e.clientY - (this._downY ?? e.clientY));
        if (moved > 4) return; // drag-selection, don't jump
        const singleClick = plugin.settings.entityClickJump !== false;
        if (!singleClick && !(e.ctrlKey || e.metaKey)) return;
        const pos = this.view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos == null) return;
        const m = (this.mentions || []).find((x) => pos >= x.from && pos < x.to);
        if (m) { e.preventDefault(); plugin.openEntityFile(m.entity.id); plugin.hideHover(); }
      }
      update(u) {
        if (u.docChanged) {
          /* v2.8: typing sound — only real keypresses beep */
          plugin.playTypeSound();
          if (plugin.settings.autoCollectBracket && !plugin.capturing) this.detectCapture(u);
          /* v2.1 word stats: only files under the manuscript folder count, booked by word-count deltas */
          const f = plugin.app.workspace.getActiveFile();
          const bodyDir = normalizePath(plugin.settings.folderBody || 'Manuscript');
          if (f && f.extension === 'md' && f.path.indexOf(bodyDir + '/') === 0) {
            const text = u.state.doc.toString();
            const now = countWords(text);
            const before = (plugin.liveCounts[f.path] != null) ? plugin.liveCounts[f.path] : (plugin.wordCache[f.path] || 0);
            const delta = now - before;
            plugin.liveCounts[f.path] = now;
            plugin.liveText = text; plugin._livePath = f.path;
            if (delta > 0) plugin.recordTyping(f.path, delta);
            else if (delta < 0) plugin.recordDeletion(-delta);
            else plugin.refreshProgressBar();
          }
        }
        if (u.docChanged || u.selectionSet || u.viewportChanged || this.version !== plugin.entityVersion) this.decorations = this.build();
      }
      detectCapture(u) {
        let closePos = -1;
        u.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
          const s = inserted.toString();
          const idx = s.lastIndexOf(']');
          if (idx >= 0) closePos = fromB + idx;
        });
        if (closePos < 0) return;
        const text = u.state.doc.toString();
        const re = /\[[^\[\]]{0,300}\]/g;
        let m, hit = null;
        while ((m = re.exec(text)) !== null) { if (m.index + m[0].length - 1 === closePos) { hit = m; break; } }
        if (!hit) return;
        const open = hit.index, content = hit[0].slice(1, -1);
        const file = plugin.app.workspace.getActiveFile();
        const path = file ? file.path : '';
        plugin.capturing = true;
        const view = u.view;
        setTimeout(() => {
          try {
            const len = view.state.doc.length;
            if (closePos + 1 <= len && view.state.doc.sliceString(open, open + 1) === '[' && view.state.doc.sliceString(closePos, closePos + 1) === ']') {
              view.dispatch({ changes: { from: open, to: closePos + 1 }, selection: { anchor: open } });
            }
          } catch (e) { /* ignore */ }
          plugin.capturing = false;
        }, 0);
        if (content.trim()) plugin.captureInspiration(content, path);
      }
      onMove(e) {
        const pos = this.view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos == null) { plugin.hideHover(); plugin.hideAnnotHover(); return; }
        /* Annotations first: hovering over annotation shading shows the annotation content */
        const ann = (this.annotRanges || []).find((x) => pos >= x.from && pos < x.to);
        if (ann) { plugin.hideHover(); plugin.showAnnotHover(ann.annot, e.clientX, e.clientY); return; }
        plugin.hideAnnotHover();
        const m = this.mentions.find((x) => pos >= x.from && pos < x.to);
        if (m) plugin.showHover(m.entity, e.clientX, e.clientY);
        else plugin.hideHover();
      }
      build() {
        const state = this.view.state;
        const text = state.doc.toString();
        this.version = plugin.entityVersion;
        const ranges = [];
        if (plugin.settings.dialogueHighlight) {
          const re = plugin.settings.dialogueEnglish ? /[“"][^”"]*[”"]/g : /“[^”]*”/g;
          let m;
          while ((m = re.exec(text)) !== null) ranges.push({ kind: 'dialogue', from: m.index, to: m.index + m[0].length, deco: Decoration.mark({ class: 'nws-dialogue' }) });
        }
        if (plugin.settings.noteChip) {
          const re2 = /\[[^\[\]]{0,300}\]/g; let m2;
          while ((m2 = re2.exec(text)) !== null) ranges.push({ kind: 'note', from: m2.index, to: m2.index + m2[0].length, deco: Decoration.mark({ class: 'nws-note-chip' }) });
        }
        this.mentions = [];
        if (plugin.settings.entityHighlight) {
          this.mentions = plugin.mentionRanges(text);
          for (const r of this.mentions) {
            const e = r.entity;
            /* v2.11: keep the body emoji-free — never write type icons into decoration attributes */
            const colorClass = hasEntityColor(e) ? ('nws-colored nws-c' + (e.color % 6)) : 'nws-nocolor';
            ranges.push({
              from: r.from, to: r.to, kind: 'entity',
              deco: Decoration.mark({
                class: 'nws-entity ' + colorClass,
                attributes: { 'title': String(e.name || '') + (e.type ? ' · ' + e.type : '') }
              })
            });
          }
        }
        if (plugin.settings.currentPara || plugin.settings.typingMode) {
          const head = state.selection.main.head;
          const line = state.doc.lineAt(head);
          const empty = (n) => state.doc.line(n).text.trim() === '';
          /* Current paragraph range (paragraphs split on blank lines) */
          let s = line.number, e = line.number;
          while (s > 1 && !empty(s - 1)) s--;
          while (e < state.doc.lines && !empty(e + 1)) e++;
          if (plugin.settings.typingMode) {
            /* Typing mode: current paragraph highlighted; neighbors fade progressively by distance */
            const radius = Math.max(1, Number(plugin.settings.typingRadius) || 2);
            for (let n = s; n <= e; n++) {
              const ln = state.doc.line(n);
              ranges.push({ from: ln.from, to: ln.from, line: true, deco: Decoration.line({ class: 'nws-tp-cur' }) });
            }
            /* Find radius paragraphs before */
            let ps = s - 1, dist = 1;
            while (ps >= 1 && dist <= radius) {
              let pe = ps;
              while (pe >= 1 && !empty(pe)) pe--;
              const start = pe + 1, end = ps;
              for (let n = start; n <= end; n++) { const ln = state.doc.line(n); ranges.push({ from: ln.from, to: ln.from, line: true, deco: Decoration.line({ class: 'nws-tp-fade f' + dist }) }); }
              ps = pe - 1; dist++;
              while (ps >= 1 && empty(ps)) ps--;
            }
            /* Find radius paragraphs after */
            let ne = e + 1; dist = 1;
            while (ne <= state.doc.lines && dist <= radius) {
              let ns = ne;
              while (ns <= state.doc.lines && !empty(ns)) ns++;
              const start = ne, end = ns - 1;
              for (let n = start; n <= end; n++) { const ln = state.doc.line(n); ranges.push({ from: ln.from, to: ln.from, line: true, deco: Decoration.line({ class: 'nws-tp-fade f' + dist }) }); }
              ne = ns + 1; dist++;
              while (ne <= state.doc.lines && empty(ne)) ne++;
            }
          } else {
            for (let n = s; n <= e; n++) { const ln = state.doc.line(n); ranges.push({ from: ln.from, to: ln.from, line: true, deco: Decoration.line({ class: 'nws-curpara' }) }); }
          }
        }
        /* v2.7: annotation shading (annotate selected text, original untouched) */
        this.annotRanges = [];
        const cf = plugin.app.workspace.getActiveFile();
        if (cf && plugin.settings.annotShow !== false) {
          const anns = (plugin.data.annotations || []).filter((a) => a.path === cf.path && a.quote);
          for (const a of anns) {
            let idx = text.indexOf(a.quote, Math.max(0, Math.min(a.from || 0, Math.max(0, text.length - 1))));
            if (idx < 0) idx = text.indexOf(a.quote);
            if (idx < 0) continue;
            ranges.push({ from: idx, to: idx + a.quote.length, kind: 'annot', deco: Decoration.mark({ class: 'nws-annot' }) });
            this.annotRanges.push({ from: idx, to: idx + a.quote.length, annot: a });
          }
        }
        /* Word milestones — every 300 words, a marker at the line's right edge (300/600/900…) */
        if (plugin.settings.milestoneMark !== false) {
          const stepSize = Math.max(100, Number(plugin.settings.milestoneStep) || 300);
          let cum = 0, next = stepSize;
          for (let n = 1; n <= state.doc.lines; n++) {
            const ln = state.doc.line(n);
            cum += countWords(ln.text);
            if (cum >= next) {
              const reached = Math.floor(cum / stepSize) * stepSize;
              ranges.push({ from: ln.from, to: ln.from, line: true, kind: 'mile', deco: Decoration.line({ class: 'nws-milestone', attributes: { 'data-m': String(reached) } }) });
              next = (Math.floor(cum / stepSize) + 1) * stepSize;
            }
          }
        }
        /* Sort + dedupe: handed to Decoration.set(sort=true); CM6 guarantees a valid order */
        const decos = [];
        const seen = Object.create(null);
        for (const r of ranges) {
          if (!r.line && r.to <= r.from) continue;
          const key = r.from + ':' + r.to + ':' + ((r.deco.spec && r.deco.spec.class) || '');
          if (seen[key]) continue;
          seen[key] = 1;
          decos.push(r.line ? r.deco.range(r.from, r.from) : r.deco.range(r.from, r.to));
        }
        return Decoration.set(decos, true);
      }
      destroy() {
        this.view.dom.removeEventListener('mousemove', this._move);
        this.view.dom.removeEventListener('mouseleave', this._leave);
        this.view.dom.removeEventListener('mousedown', this._down);
        this.view.dom.removeEventListener('click', this._click);
        plugin.hideHover(); plugin.hideAnnotHover();
      }
    }, { decorations: (v) => v.decorations });
    return [nwsMark];
  }
}

/* Main class ends; views/modals/settings follow below */

/* ================= Panel views ================= */
function setViewRoot(view, html) {
  view.contentEl.empty();
  const root = el('div', 'nws-root nws-view');
  root.innerHTML = html;
  view.contentEl.appendChild(root);
  return root;
}

/* ---------- Catalog (volumes + chapters) ---------- */
class CatalogView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; }
  getViewType() { return VIEW_CATALOG; }
  getDisplayText() { return 'Studio · Catalog'; }
  getIcon() { return 'folder-tree'; }
  async onOpen() { this.render(); }
  render() {
    const p = this.plugin;
    const chapters = p.allChapters();
    const total = chapters.reduce((s, c) => s + c.words, 0);
    const vols = Object.create(null);
    chapters.forEach((c) => { (vols[c.volume] = vols[c.volume] || []).push(c); });
    let body = '';
    Object.keys(vols).forEach((v) => {
      const list = vols[v];
      const vw = list.reduce((s, c) => s + c.words, 0);
      const renameBtn = '<button class="nws-btn sm nws-vol-ren" data-ren="' + escapeHtml(v) + '" title="Rename volume">✎</button>';
      const vstatBtn = '<button class="nws-btn sm nws-chbtn" data-vstat="' + escapeHtml(v) + '" title="Volume analytics: words / status / pace / lore usage">📊</button>';
      body += '<div class="nws-vol" data-vol="' + escapeHtml(v) + '"><div class="nws-vol-h">' +
        '<span class="nws-vol-name" data-ren="' + escapeHtml(v) + '" title="Click to rename volume">📁 ' + escapeHtml(v) + '</span>' +
        '<span class="nws-vol-tools"><span class="wc">' + fmt(vw) + ' words</span>' + vstatBtn + renameBtn + '</span></div>';
      list.forEach((c) => {
        const st = c.status == null ? (c.words > 0 ? 1 : 0) : c.status;
        const target = p.targetOf(c.path);
        // per-chapter lore stats summary
        const chMap = p.stats.perChapter[c.path] || {};
        const topEnts = Object.keys(chMap).sort((a, b) => chMap[b] - chMap[a]).slice(0, 3)
          .map((id) => { const e = p.entityById(id); return e ? escapeHtml(e.name) + '×' + chMap[id] : ''; }).filter(Boolean).join(' · ');
        const stOpts = CH_STATUS.map((s, i) => '<option value="' + i + '"' + (i === st ? ' selected' : '') + '>' + s + '</option>').join('');
        body += '<div class="nws-chap" data-path="' + escapeHtml(c.path) + '" draggable="true">' +
          '<span class="nws-st s' + st + '"></span>' +
          '<span class="t">' + escapeHtml(c.title) + '</span>' +
          (topEnts ? '<span class="nws-chents" title="Lore used in this chapter">' + topEnts + '</span>' : '') +
          '<select class="nws-status-sel s' + st + '" data-status="' + escapeHtml(c.path) + '" title="Chapter status">' + stOpts + '</select>' +
          '<span class="w" data-target="' + escapeHtml(c.path) + '" title="Goal ' + fmt(target) + ' words · click to change">' + fmt(c.words) + '</span>' +
          '<button class="nws-btn sm nws-chbtn" data-cmove="' + escapeHtml(c.path) + '" title="Move to another volume">📁</button>' +
          '<button class="nws-btn sm nws-chbtn" data-cstat="' + escapeHtml(c.path) + '" title="Chapter stats: goal / pace / focus / lore categories / Top 10">📊</button>' +
          '</div>';
      });
      body += '<button class="nws-btn sm nws-vol-add" data-act="newchap" data-vol="' + escapeHtml(v) + '">＋ New chapter here</button>';
      body += '</div>';
    });
    if (!body) body = '<div class="nws-empty">No chapters in the manuscript yet.<br>Click "＋ New Volume" or "＋ New Chapter" to start.</div>';

    const root = setViewRoot(this,
      '<div class="nws-phead"><div class="nws-row"><div class="nws-ptitle">Catalog <span class="nws-tag g">' + escapeHtml((function(){ try { return p.app.vault.getName(); } catch (e) { return ''; } })()) + '</span></div>' +
      '<div class="nws-sp"></div><button class="nws-btn" data-act="newvol">＋ New Volume</button><button class="nws-btn pri" data-act="newchap-top">＋ New Chapter</button></div>' +
      '<div class="nws-psub">' + chapters.length + ' chapters · ' + fmt(total) + ' words · drag a chapter into another volume · click a volume name / ✎ to rename · click the word count to set a goal</div>' +
      '<div class="nws-folders">' +
      '<button class="nws-fold" data-view="outline">📋 Outline</button>' +
      '<button class="nws-fold" data-view="entities">⚙️ Lore</button>' +
      '<button class="nws-fold" data-view="plots">🧩 Plot</button>' +
      '<button class="nws-fold" data-view="lines">⏳🗺️ Lines</button>' +
      '<button class="nws-fold on" data-view="catalog">📖 Manuscript</button>' +
      '<button class="nws-fold" data-view="notes">💡 Ideas</button>' +
      '<button class="nws-fold" data-view="annots">📝 Annotations</button>' +
      '<button class="nws-fold" data-view="stats">📊 Data</button>' +
      '</div></div>' +
      '<div class="nws-catalog">' + body + '</div>');

    /* Drag & drop: chapter rows can be dragged into other volumes */
    let dragPath = null;
    root.querySelectorAll('.nws-chap').forEach((row) => {
      row.addEventListener('dragstart', (e) => {
        dragPath = row.dataset.path;
        try { e.dataTransfer.setData('text/plain', row.dataset.path); e.dataTransfer.effectAllowed = 'move'; } catch (err) { /* ignore */ }
        row.classList.add('nws-dragging');
      });
      row.addEventListener('dragend', () => {
        dragPath = null;
        row.classList.remove('nws-dragging');
        root.querySelectorAll('.nws-droptarget').forEach((x) => x.classList.remove('nws-droptarget'));
      });
    });
    root.querySelectorAll('.nws-vol').forEach((vol) => {
      vol.addEventListener('dragover', (e) => { if (dragPath) { e.preventDefault(); try { e.dataTransfer.dropEffect = 'move'; } catch (err) { /* ignore */ } vol.classList.add('nws-droptarget'); } });
      vol.addEventListener('dragleave', (e) => { if (!vol.contains(e.relatedTarget)) vol.classList.remove('nws-droptarget'); });
      vol.addEventListener('drop', (e) => {
        e.preventDefault();
        vol.classList.remove('nws-droptarget');
        const path = dragPath || (e.dataTransfer ? e.dataTransfer.getData('text/plain') : '');
        if (path && vol.dataset.vol) p.moveChapter(path, vol.dataset.vol);
        dragPath = null;
      });
    });

    root.querySelectorAll('.nws-chap').forEach((row) => row.addEventListener('click', (e) => {
      if (e.target.closest('[data-status]') || e.target.closest('[data-target]') || e.target.closest('[data-cstat]') || e.target.closest('[data-cmove]')) return; // status / goal / stats / move clicks handled separately
      p.openChapterByPath(row.dataset.path);
    }));
    /* 📁 Move a chapter to another volume */
    root.querySelectorAll('[data-cmove]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      new ChapterMoveModal(this.app, p, b.dataset.cmove).open();
    }));
    /* 📊 Chapter stats */
    root.querySelectorAll('[data-cstat]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      new ChapterStatsModal(this.app, p, b.dataset.cstat).open();
    }));
    /* 📊 Volume analytics */
    root.querySelectorAll('[data-vstat]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      new VolumeStatsModal(this.app, p, b.dataset.vstat).open();
    }));
    /* Status: dropdown (Draft / Writing / Needs Revision / Final) */
    root.querySelectorAll('select[data-status]').forEach((sel) => sel.addEventListener('change', async () => {
      const path = sel.dataset.status;
      const st = parseInt(sel.value, 10);
      await p.setMeta(path, { status: st });
      new Notice('Status → ' + CH_STATUS[st]);
      this.render();
    }));
    /* Word-count label: click to set a goal */
    root.querySelectorAll('[data-target]').forEach((b) => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const path = b.dataset.target;
      new InputModal(this.app, 'Chapter word goal (0 = follow global)', String(p.targetOf(path)), async (v) => {
        const n = parseInt(v, 10); if (isNaN(n) || n < 0) return;
        await p.setMeta(path, { target: n }); await p.rescan(true);
        new Notice(n > 0 ? 'Goal set to ' + fmt(n) + ' words' : 'Now following the global goal');
      }).open();
    }));
    root.querySelectorAll('[data-act="newchap"]').forEach((b) => b.addEventListener('click', () => p.newChapter(b.dataset.vol)));
    root.querySelector('[data-act="newvol"]').addEventListener('click', () => p.newVolume());
    root.querySelector('[data-act="newchap-top"]').addEventListener('click', () => p.newChapter('(Unfiled)'));
    root.querySelectorAll('[data-ren]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const old = b.dataset.ren;
      new InputModal(this.app, old === '(Unfiled)' ? 'Rename unfiled (creates a volume folder and moves all unfiled chapters into it)' : 'Rename volume', old, (v) => {
        if (v && v.trim()) p.renameVolume(old, v.trim());
      }).open();
    }));
    root.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => p.openPath(b.dataset.open)));
    const vmap = { outline: VIEW_OUTLINE, entities: VIEW_ENTITIES, plots: VIEW_PLOTS, lines: VIEW_LINES, catalog: VIEW_CATALOG, notes: VIEW_NOTES, annots: VIEW_ANNOT, stats: VIEW_STATS };
    root.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => { if (vmap[b.dataset.view]) p.activateView(vmap[b.dataset.view]); }));
  }
}

/* ---------- Outline ---------- */
class OutlineView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.type = 'All'; }
  getViewType() { return VIEW_OUTLINE; }
  getDisplayText() { return 'Studio · Outline'; }
  getIcon() { return 'list-tree'; }
  async onOpen() { this.render(); }
  render() {
    const p = this.plugin;
    const types = ['All'].concat(p.data.outlineTypes);
    const list = p.data.outlines.filter((o) => this.type === 'All' || o.type === this.type);
    const typeBtns = types.map((t) => {
      const n = t === 'All' ? p.data.outlines.length : p.data.outlines.filter((o) => o.type === t).length;
      return '<button class="nws-fbtn ' + (this.type === t ? 'on' : '') + '" data-t="' + escapeHtml(t) + '">' +
        (t === 'All' ? 'All' : typeEmoji(t, true) + ' ' + escapeHtml(t)) + '<span class="nws-cnt">' + n + '</span></button>';
    }).join('');
    const cards = list.map((o) => {
      const binds = (o.bindings || []).map((b) => {
        const icon = b.kind === 'chapter' ? '📄' : b.kind === 'entity' ? '🔗' : '📋';
        return '<span class="nws-bind" data-bind-kind="' + b.kind + '" data-bind-id="' + escapeHtml(b.id) + '">' + icon + ' ' + escapeHtml(b.name || b.id) + '</span>';
      }).join('');
      const c = (o.color == null ? 3 : o.color) % 6;
      return '<div class="nws-oc" data-id="' + o.id + '">' +
        '<div class="nws-oc-h"><span class="nws-cdot" style="background:' + PALETTE[c] + '"></span>' +
        '<span class="nws-otype">' + outlineEmoji(o.type) + ' ' + escapeHtml(o.type) + '</span>' +
        '<span class="nws-otitle">' + escapeHtml(o.title) + '</span>' +
        '<span class="nws-sp"></span>' +
        '<button class="nws-btn sm" data-act="file" title="Open outline file">📄 File</button>' +
        '<button class="nws-btn sm" data-act="bind">🔗 Link</button>' +
        '<button class="nws-btn sm" data-act="edit">✎</button>' +
        '<button class="nws-btn sm" data-act="del">Del</button></div>' +
        (o.desc ? '<div class="nws-odesc">' + escapeHtml(o.desc) + '</div>' : '') +
        '<div class="nws-otpl">📝 Template: ' + outlineTemplateFields(o.type).slice(0, 5).map(escapeHtml).join(' · ') + (outlineTemplateFields(o.type).length > 5 ? ' …' : '') + '</div>' +
        (binds ? '<div class="nws-obinds"><span class="nws-clabel">Linked: </span>' + binds + '</div>' : '<div class="nws-obindhint">Not linked · click "Link" to link chapters / lore / other outlines</div>') +
        '</div>';
    }).join('') || '<div class="nws-empty">No outline entries yet.<br>Click "＋ New Outline" to create one from a type template; a same-name md note is generated.</div>';

    const root = setViewRoot(this,
      '<div class="nws-phead"><div class="nws-row"><div class="nws-ptitle">Outline <span class="nws-tag">' + p.data.outlines.length + ' items</span></div>' +
      '<div class="nws-sp"></div><button class="nws-btn" data-act="newtype">＋ Type</button><button class="nws-btn pri" data-act="add">＋ New Outline</button></div>' +
      '<div class="nws-psub">Organized by type templates · each entry can link targets · creating one generates a same-name note under Outline/ (with link params and template skeleton)</div>' +
      '<div class="nws-filters">' + typeBtns + '</div></div>' +
      '<div class="nws-ocards">' + cards + '</div>');

    root.querySelectorAll('[data-t]').forEach((b) => b.addEventListener('click', () => { this.type = b.dataset.t; this.render(); }));
    root.querySelector('[data-act="add"]').addEventListener('click', () => {
      new OutlineCreateModal(this.app, p, this.type === 'All' ? null : this.type).open();
    });
    root.querySelector('[data-act="newtype"]').addEventListener('click', () => {
      new InputModal(this.app, 'New outline type', 'Type name', (name) => {
        if (!name || !name.trim()) return;
        if (p.data.outlineTypes.indexOf(name.trim()) >= 0) { new Notice('Type already exists'); return; }
        p.data.outlineTypes.push(name.trim()); p.saveNow(); this.render();
      }).open();
    });
    root.querySelectorAll('.nws-oc').forEach((card) => {
      const id = card.dataset.id;
      card.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
        const act = b.dataset.act;
        if (act === 'del') { p.deleteOutline(id); }
        else if (act === 'file') { p.openOutlineFile(id); }
        else if (act === 'edit') { new OutlineEditModal(this.app, p, p.outlineById(id)).open(); }
        else if (act === 'bind') { new BindModal(this.app, p, 'outline', id).open(); }
      }));
      card.querySelectorAll('[data-bind-kind]').forEach((tag) => tag.addEventListener('click', () => {
        const kind = tag.dataset.bindKind, bid = tag.dataset.bindId;
        if (kind === 'chapter') p.openChapterByPath(bid);
        else if (kind === 'entity') new EntityDetailModal(this.app, p, p.entityById(bid)).open();
        else if (kind === 'outline') p.activateView(VIEW_OUTLINE);
      }));
    });
  }
}

/* ---------- Lore library (v2.6 big-category edition: 6 categories + Standalone, file-based) ---------- */
class EntitiesView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.color = -1; this.q = ''; this.group = 'All'; }
  getViewType() { return VIEW_ENTITIES; }
  getDisplayText() { return 'Studio · Lore Library'; }
  getIcon() { return 'shapes'; }
  async onOpen() { this.render(); }
  render() {
    const p = this.plugin, ag = p.aggregate();
    const match = (e) => {
      const grp = e.group || groupOfLib(e.type);
      return (this.group === 'All' || grp === this.group) &&
        (this.color === -1 || (hasEntityColor(e) && (e.color % 6) === this.color) || (!hasEntityColor(e) && this.color === -2)) &&
        (!this.q || e.name.indexOf(this.q) >= 0 || (e.aliases || []).join('').indexOf(this.q) >= 0);
    };
    const list = p.data.entities.filter(match);

    /* Top level: 6 categories + Standalone (v2.6 big-category edition, no second-level libraries) */
    const groupBtns = ['All'].concat(ENTITY_GROUPS.map((g) => g.name)).map((g) => {
      const n = g === 'All' ? p.data.entities.length : p.data.entities.filter((e) => (e.group || groupOfLib(e.type)) === g).length;
      const emo = g === 'All' ? '🗂️' : groupEmoji(g);
      return '<button class="nws-fbtn nws-gbtn ' + (this.group === g ? 'on' : '') + '" data-g="' + escapeHtml(g) + '">' +
        emo + ' ' + escapeHtml(g) + '<span class="nws-cnt">' + n + '</span></button>';
    }).join('');

    const cardHtml = (e) => {
      const c = hasEntityColor(e) ? e.color % 6 : -1;
      const pe = ag.perEntity[e.id] || { total: 0, chapters: {} };
      const bindCount = (e.bindings || []).length;
      const lib = LIB_BY_NAME[e.type];
      const binds = (e.bindings || []).map((b) => '<span class="nws-bind" title="' + escapeHtml(b.kind) + '">' +
        (b.kind === 'chapter' ? '📄' : b.kind === 'entity' ? '🔗' : b.kind === 'outline' ? '📋' : '🔖') + ' ' + escapeHtml(b.name || b.id) + '</span>').join('');
      const grp = e.group || groupOfLib(e.type);
      const dotColor = c < 0 ? 'transparent' : PALETTE[c];
      const dotBorder = c < 0 ? '1px dashed var(--nws-ink2)' : 'none';
      return '<div class="nws-ecard" data-id="' + e.id + '">' +
        '<span class="nws-cdot" style="background:' + dotColor + ';border:' + dotBorder + '"></span>' +
        '<span class="nws-ename">' + (lib ? lib.emoji + ' ' : '') + escapeHtml(e.name) + '</span>' +
        '<span class="nws-tag nws-tag-grp">' + groupEmoji(grp) + ' ' + escapeHtml(grp) + '</span>' +
        '<span class="nws-tag">' + escapeHtml(e.type || 'Character') + '</span>' +
        '<span class="nws-tag nws-tag-stat">' + pe.total + ' times · ' + Object.keys(pe.chapters).length + ' chapters</span>' +
        (bindCount ? '<span class="nws-tag nws-tag-bind">🔗' + bindCount + '</span>' : '') +
        '<span class="nws-sp"></span>' +
        '<button class="nws-btn sm" data-ed="open" title="Open lore file">📄 File</button>' +
        '<button class="nws-btn sm" data-ed="detail">Details</button>' +
        '<button class="nws-btn sm" data-ed="bind">🔗</button>' +
        '<button class="nws-btn sm" data-ed="color">🎨</button>' +
        (e.desc ? '<div class="nws-edesc">' + escapeHtml(e.desc) + '</div>' : '') +
        (binds ? '<div class="nws-obinds">' + binds + '</div>' : '') +
        '</div>';
    };

    const colorBtns = '<button class="nws-cbtn ' + (this.color === -1 ? 'on' : '') + '" data-c="-1">All</button>' +
      PALETTE.map((c, i) => '<button class="nws-cbtn ' + (this.color === i ? 'on' : '') + '" data-c="' + i + '" style="--dot:' + c + '"><i></i></button>').join('') +
      '<button class="nws-cbtn ' + (this.color === -2 ? 'on' : '') + '" data-c="-2" title="No color (bold + underline)">No color</button>';
    const root = setViewRoot(this,
      '<div class="nws-phead"><div class="nws-row"><div class="nws-ptitle">Lore <span class="nws-tag">' + p.data.entities.length + ' items</span></div>' +
      '<div class="nws-sp"></div>' +
      '<button class="nws-btn" data-act="openroot" title="Open lore folder">📁 Lore folder</button>' +
      '<button class="nws-btn pri" data-act="add">🖋️ New Lore (pick category template)</button></div>' +
      '<div class="nws-psub">6 categories: World Bible · Characters · Relationships · Geography & Factions · Power & Rules · Plot & Foreshadowing, plus "Standalone" for writing styles and custom types · each entry is stored as a same-name md note under Lore/&lt;Category&gt;/ (with template / links)</div>' +
      '<input class="nws-search" placeholder="Search lore…" value="' + escapeHtml(this.q) + '">' +
      '<div class="nws-filters nws-groupbar">' + groupBtns + '</div>' +
      '<div class="nws-filters nws-colorbar"><span class="nws-clabel">Color</span>' + colorBtns + '</div></div>' +
      '<div class="nws-ecards">' +
        (list.map(cardHtml).join('') || '<div class="nws-empty">No lore matches the filters.<br>Click "🖋️ New Lore" and pick a category to create a templated note.</div>') +
      '</div>');

    root.querySelectorAll('[data-g]').forEach((b) => b.addEventListener('click', () => { this.group = b.dataset.g; this.render(); }));
    root.querySelectorAll('[data-c]').forEach((b) => b.addEventListener('click', () => { this.color = +b.dataset.c; this.render(); }));
    root.querySelector('.nws-search').addEventListener('input', debounce((e) => { this.q = e.target.value.trim(); this.render(); }, 200));
    root.querySelector('[data-act="add"]').addEventListener('click', () => { new EntityCreateModal(this.app, p, null, this.group === 'All' ? null : this.group).open(); });
    root.querySelector('[data-act="openroot"]').addEventListener('click', () => p.openPath(p.libFolder()));
    root.querySelectorAll('.nws-ecard').forEach((card) => {
      const id = card.dataset.id;
      card.querySelectorAll('[data-ed]').forEach((b) => b.addEventListener('click', () => {
        const act = b.dataset.ed;
        if (act === 'open') p.openEntityFile(id);
        else if (act === 'detail') new EntityDetailModal(this.app, p, p.entityById(id)).open();
        else if (act === 'bind') new BindModal(this.app, p, 'entity', id).open();
        else if (act === 'color') { const e = p.entityById(id); new ColorModal(this.app, e, (ci) => p.updateEntity(id, { color: ci })).open(); }
      }));
    });
  }
}

/* ---------- Ideas ---------- */
class NotesView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.status = 'All'; }
  getViewType() { return VIEW_NOTES; }
  getDisplayText() { return 'Studio · Ideas'; }
  getIcon() { return 'lightbulb'; }
  async onOpen() { this.render(); }
  render() {
    const p = this.plugin;
    const notes = (p.data.notes || []).slice().sort((a, b) => {
      const order = { 'Pending': 0, 'Adopted': 1, 'Dropped': 2 };
      return (order[a.status] == null ? 0 : order[a.status]) - (order[b.status] == null ? 0 : order[b.status]) || (b.created - a.created);
    });
    const statusChip = (s) => {
      const k = (s === 'Adopted' ? 'ok' : s === 'Dropped' ? 'no' : 'todo');
      return '<span class="nws-nstatus ' + k + '">' + (k === 'ok' ? '✓ ' : k === 'no' ? '✕ ' : '◌ ') + escapeHtml(s || 'Pending') + '</span>';
    };
    const filterBtns = ['All', 'Pending', 'Adopted', 'Dropped'].map((s) => {
      const n = s === 'All' ? notes.length : notes.filter((x) => x.status === s).length;
      return '<button class="nws-fbtn ' + ((this.status || 'All') === s ? 'on' : '') + '" data-ns="' + s + '">' + s + '<span class="nws-cnt">' + n + '</span></button>';
    }).join('');
    const shown = notes.filter((n) => !this.status || this.status === 'All' || n.status === this.status);
    const cards = shown.map((n) => {
      const binds = (n.bindings || []).map((b) => '<span class="nws-bind">' + (b.kind === 'plot' ? '🧩' : typeEmoji(b.type || b.kind)) + ' ' + escapeHtml(b.name || b.id) + '</span>').join('');
      return '<div class="nws-ncard" data-nid="' + n.id + '"><div class="nws-nrow">' + statusChip(n.status) + '<span class="nws-sp"></span>' +
        (n.file ? '<button class="nws-btn sm" data-na="open">Open note</button>' : '') +
        '<button class="nws-btn sm" data-na="edit">✎ Edit</button><button class="nws-btn sm" data-na="del">Del</button></div>' +
        '<div class="txt">' + escapeHtml(n.content) + '</div>' +
        (binds ? '<div class="nws-nbinds">' + binds + '</div>' : '') +
        '<div class="meta"><span>Source: ' + escapeHtml(n.sourcePath ? String(n.sourcePath).split('/').pop().replace(/\.md$/, '') : 'Manual') + '</span><span>·</span><span>' + escapeHtml(stampFrom(n.created)) + '</span></div></div>';
    }).join('') || '<div class="nws-empty">No ideas with this status.<br>Select text in the body, right-click "Save as idea", or type [an idea] and close with ] to auto-collect.</div>';
    const root = setViewRoot(this,
      '<div class="nws-phead"><div class="nws-row"><div class="nws-ptitle">Ideas <span class="nws-tag">' + notes.length + ' items</span></div>' +
      '<div class="nws-sp"></div><button class="nws-btn pri" data-act="new">＋ New Idea</button><button class="nws-btn" data-act="open">Open ideas folder</button></div>' +
      '<div class="nws-psub">Select body text and right-click to save · each idea can link lore (plots / characters etc.) and carry a status (Pending / Adopted / Dropped) · each idea is stored as its own md note</div>' +
      '<div class="nws-filters">' + filterBtns + '</div></div>' +
      '<div class="nws-notes-grid">' + cards + '</div>');
    root.querySelector('[data-act="open"]').addEventListener('click', () => p.openPath(p.inspirationRoot()));
    root.querySelector('[data-act="new"]').addEventListener('click', () => new InspirationEditModal(this.app, p, null).open());
    root.querySelectorAll('[data-ns]').forEach((b) => b.addEventListener('click', () => { this.status = b.dataset.ns; this.render(); }));
    root.querySelectorAll('.nws-ncard').forEach((card) => {
      const id = card.dataset.nid;
      card.querySelectorAll('[data-na]').forEach((b) => b.addEventListener('click', () => {
        if (b.dataset.na === 'edit') new InspirationEditModal(this.app, p, p.noteById(id)).open();
        else if (b.dataset.na === 'del') p.deleteNote(id);
        else if (b.dataset.na === 'open') { const n = p.noteById(id); if (n && n.file) p.app.workspace.getLeaf('tab').openFile(p.app.vault.getAbstractFileByPath(n.file)); }
      }));
    });
  }
}

/* ================= v1.3 plot view ================= */
class PlotsView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.q = ''; }
  getViewType() { return VIEW_PLOTS; }
  getDisplayText() { return 'Studio · Plot'; }
  getIcon() { return 'git-branch'; }
  async onOpen() { this.render(); }
  render() {
    const p = this.plugin;
    const list = p.data.plots.filter((pl) => !this.q || pl.name.indexOf(this.q) >= 0 || (pl.tags || []).join('').indexOf(this.q) >= 0);
    const cards = list.map((pl) => {
      const c = pl.color == null ? 3 : pl.color;
      const done = p.plotStageDone(pl);
      const stageBtns = PLOT_STAGES.map((s) => {
        const filled = (pl.stages && pl.stages[s.key] || '').trim();
        return '<div class="nws-stage ' + (filled ? 'done' : '') + '"><span class="nws-stage-ic">' + s.emoji + '</span>' +
          '<span class="nws-stage-label">' + s.label + '</span>' +
          '<span class="nws-stage-txt">' + (filled ? escapeHtml(filled) : 'Not filled') + '</span></div>';
      }).join('');
      const roles = (pl.roles || []).map((r) => '<span class="nws-bind">👤 ' + escapeHtml(r.name || r.id) + '</span>').join('');
      const chs = (pl.chapters || []).map((c) => '<span class="nws-bind">📄 ' + escapeHtml(c.name || c.id) + '</span>').join('');
      const tags = (pl.tags || []).map((t) => '<span class="nws-tag">#' + escapeHtml(t) + '</span>').join('');
      return '<div class="nws-plot" data-id="' + pl.id + '">' +
        '<div class="nws-plot-h">' +
        '<span class="nws-cdot" style="background:' + PALETTE[c % 6] + '"></span>' +
        '<span class="nws-plot-name">🧩 ' + escapeHtml(pl.name) + '</span>' +
        '<span class="nws-tag nws-tag-stat">' + done + '/4 stages</span>' +
        '<span class="nws-sp"></span>' +
        '<button class="nws-btn sm" data-pa="edit">✎ Edit</button>' +
        '<button class="nws-btn sm" data-pa="del">Del</button></div>' +
        '<div class="nws-stages">' + stageBtns + '</div>' +
        (roles || chs || tags ? '<div class="nws-plot-meta">' + roles + chs + tags + '</div>' : '') +
        (pl.note ? '<div class="nws-plot-note">📝 ' + escapeHtml(pl.note) + '</div>' : '') +
        '</div>';
    }).join('') || '<div class="nws-empty">No plots yet.<br>Click "＋ New Plot" and structure it in four stages: beginning / development / climax / resolution.</div>';

    const root = setViewRoot(this,
      '<div class="nws-phead"><div class="nws-row"><div class="nws-ptitle">Plot <span class="nws-tag">' + p.data.plots.length + ' items</span></div>' +
      '<div class="nws-sp"></div><button class="nws-btn pri" data-act="new">＋ New Plot</button></div>' +
      '<div class="nws-psub">Four stages (beginning · development · climax · resolution) · link characters and chapter ranges · tags / color / notes</div>' +
      '<input class="nws-search" placeholder="Search plots…" value="' + escapeHtml(this.q) + '">' +
      '<div class="nws-folders"><button class="nws-fold" data-view="lines">⏳🗺️💗 Open time / location / emotion lines</button></div></div>' +
      '<div class="nws-plots">' + cards + '</div>');

    root.querySelector('[data-act="new"]').addEventListener('click', () => new PlotModal(this.app, p, null).open());
    root.querySelector('[data-view="lines"]').addEventListener('click', () => p.activateView(VIEW_LINES));
    root.querySelector('.nws-search').addEventListener('input', debounce((e) => { this.q = e.target.value.trim(); this.render(); }, 200));
    root.querySelectorAll('.nws-plot').forEach((card) => {
      const id = card.dataset.id;
      card.querySelectorAll('[data-pa]').forEach((b) => b.addEventListener('click', () => {
        const act = b.dataset.pa;
        if (act === 'edit') new PlotModal(this.app, p, p.plotById(id)).open();
        else if (act === 'del') p.deletePlot(id);
      }));
    });
  }
}

/* ================= v2.4 time/location/emotion multi-line view ================= */
class LinesView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; }
  getViewType() { return VIEW_LINES; }
  getDisplayText() { return 'Studio · Time / Location / Emotion Lines'; }
  getIcon() { return 'git-merge'; }
  async onOpen() { this.render(); }
  nodeHtml(n) {
    const p = this.plugin;
    const binds = (n.bindings || []).map((b) => {
      const em = b.kind === 'plot' ? '🧩' : typeEmoji(b.type || b.kind);
      return '<span class="nws-lbind" data-nb="' + escapeHtml(b.kind) + '" data-nbid="' + escapeHtml(b.id) + '">' + em + ' ' + escapeHtml(b.name || b.id) + '</span>';
    }).join('');
    return '<div class="nws-node" data-nid="' + n.id + '">' +
      '<div class="nws-node-at">' + escapeHtml(n.at || '') + '</div>' +
      '<div class="nws-node-label">' + escapeHtml(n.label) + '</div>' +
      '<div class="nws-node-content">' + escapeHtml(n.content || p.lineNodeContentHint(n)) + '</div>' +
      (binds ? '<div class="nws-node-binds">' + binds + '</div>' : '') +
      '<div class="nws-node-tools">' +
      '<button class="nws-btn sm" data-na="edit" title="Edit node">✎</button>' +
      '<button class="nws-btn sm" data-na="up" title="Move up">↑</button>' +
      '<button class="nws-btn sm" data-na="down" title="Move down">↓</button>' +
      '<button class="nws-btn sm" data-na="del" title="Delete">Del</button></div>' +
      '</div>';
  }
  /* One track = one column */
  trackColumn(t) {
    const p = this.plugin;
    const nodes = p.nodesOfLine(t.id);
    const vd = trackViewDef(t.view), ad = trackAxisDef(t.axis);
    const body = nodes.map((n) => this.nodeHtml(n)).join('') || '<div class="nws-line-empty">No nodes on this line yet.<br>Click "＋ Add ' + escapeHtml(vd.node) + '" to start.</div>';
    /* Track-level links (who/what the whole line revolves around) */
    const binds = (t.bindings || []).map((b) =>
      '<span class="nws-track-bind" data-tb="' + escapeHtml(b.kind) + '" data-tbid="' + escapeHtml(b.id) + '">' +
      (b.kind === 'plot' ? '🧩' : typeEmoji(b.type || b.kind)) + ' ' + escapeHtml(b.name || b.id) + '</span>').join('');
    return '<div class="nws-linecol nws-line-' + t.axis + '" data-tid="' + t.id + '">' +
      '<div class="nws-linecol-h"><span class="nws-track-h"><span class="nws-track-emoji">' + ad.emoji + vd.emoji + '</span>' +
      '<span class="nws-track-name" data-ta="rename" title="Click to rename">' + escapeHtml(t.name) + ' <span class="nws-rename-ic">✎</span></span>' +
      '<span class="nws-track-vtag">' + vd.name + '</span></span>' +
      '<span class="nws-track-tools">' +
      '<button class="nws-btn sm" data-ta="bind" title="Link targets (who/what this line revolves around)">🔗</button>' +
      '<button class="nws-btn sm" data-ta="up" title="Move forward in group">‹</button>' +
      '<button class="nws-btn sm" data-ta="down" title="Move backward in group">›</button>' +
      '<button class="nws-btn sm" data-ta="edit" title="Edit line (name / axis / view / links)">✎</button>' +
      '<button class="nws-btn sm" data-ta="del" title="Delete line">✕</button></span></div>' +
      (binds || '' ? '<div class="nws-track-binds">' + binds + '</div>' : '') +
      '<div class="nws-track-add"><button class="nws-btn sm pri" data-act="addline" data-line="' + t.id + '">＋ Add ' + escapeHtml(vd.node) + '</button></div>' +
      '<div class="nws-linetrack">' + body + '</div></div>';
  }
  render() {
    const p = this.plugin;
    const tracks = p.visibleTracks();
    const totalNodes = (p.data.lineNodes || []).length;
    /* Independent axis toggles: any combination (time-only / location-only / emotion-only / several in parallel) */
    const axisBtns = TRACK_AXES.map((a) => {
      const on = p.axisOn(a.key);
      const n = (p.data.tracks || []).filter((t) => t.axis === a.key).length;
      return '<button class="nws-fbtn ' + (on ? 'on' : '') + '" data-axis="' + a.key + '">' + a.emoji + ' ' + a.name + ' <span class="nws-cnt">' + n + '</span></button>';
    }).join('');
    /* Render grouped by the three axes, separated between groups; only enabled axes render */
    const groups = TRACK_AXES.filter((a) => p.axisOn(a.key)).map((a) => {
      const list = tracks.filter((t) => t.axis === a.key);
      if (!list.length) return '';
      return '<div class="nws-axis-group" data-group="' + a.key + '">' +
        list.map((t) => this.trackColumn(t)).join('') + '</div>';
    }).filter(Boolean);
    let cols = groups.join('<div class="nws-line-divider"></div>');
    if (!tracks.length) cols = '<div class="nws-empty">No lines on the visible axes yet.<br>Click "＋ New Line" to create one, or enable any axis above.</div>';

    const root = setViewRoot(this,
      '<div class="nws-phead"><div class="nws-row"><div class="nws-ptitle">Time / Location / Emotion Lines <span class="nws-tag">' +
      tracks.length + ' lines · ' + totalNodes + ' nodes</span></div>' +
      '<div class="nws-sp"></div>' +
      '<button class="nws-fold" data-view="plots">🧩 Plot</button>' +
      '<button class="nws-btn pri" data-act="newtrack">＋ New Line</button></div>' +
      '<div class="nws-psub">Three line types can exist alone or be compared side by side; click a name to rename. Each line can link characters / lore / plots; the view decides node naming</div>' +
      '<div class="nws-filters">' + axisBtns + '</div></div>' +
      '<div class="nws-lines">' + cols + '</div>');
    root.querySelector('[data-view="plots"]').addEventListener('click', () => p.activateView(VIEW_PLOTS));
    root.querySelectorAll('[data-axis]').forEach((b) => b.addEventListener('click', async () => { p.toggleAxis(b.dataset.axis); await p.saveNow(); this.render(); }));
    root.querySelector('[data-act="newtrack"]').addEventListener('click', () => new TrackModal(this.app, p, null).open());
    /* Track tools (rename by clicking the name, linking) */
    root.querySelectorAll('[data-ta]').forEach((b) => b.addEventListener('click', () => {
      const tid = b.closest('.nws-linecol').dataset.tid, t = p.trackById(tid), ta = b.dataset.ta;
      if (ta === 'edit') new TrackModal(this.app, p, t).open();
      else if (ta === 'rename') new InputModal(this.app, 'Rename line', 'e.g. A character\'s action trail / Royal capital geography line / Protagonist emotion curve', async (v) => { if (v.trim()) await p.updateTrack(tid, { name: v.trim() }); }, t.name).open();
      else if (ta === 'bind') new TrackBindModal(this.app, p, t).open();
      else if (ta === 'del') { if (confirm('Delete line "' + t.name + '" and all its nodes?')) p.deleteTrack(tid); }
      else if (ta === 'up') p.moveTrack(tid, -1);
      else if (ta === 'down') p.moveTrack(tid, 1);
    }));
    /* Click a track link chip to jump */
    root.querySelectorAll('[data-tb]').forEach((tag) => tag.addEventListener('click', () => {
      const kind = tag.dataset.tb, bid = tag.dataset.tbid;
      if (kind === 'plot') p.activateView(VIEW_PLOTS);
      else { const e = p.entityById(bid); if (e) new EntityDetailModal(this.app, p, e).open(); }
    }));
    root.querySelectorAll('[data-act="addline"]').forEach((b) => b.addEventListener('click', () => new LineNodeModal(this.app, p, b.dataset.line, null).open()));
    root.querySelectorAll('.nws-node').forEach((el) => {
      const id = el.dataset.nid;
      el.querySelectorAll('[data-na]').forEach((b) => b.addEventListener('click', () => {
        const act = b.dataset.na, n = p.lineNodeById(id);
        if (act === 'edit') new LineNodeModal(this.app, p, n.trackId || n.line, n).open();
        else if (act === 'del') p.deleteLineNode(id);
        else if (act === 'up') p.moveLineNode(id, -1);
        else if (act === 'down') p.moveLineNode(id, 1);
      }));
      el.querySelectorAll('[data-nb]').forEach((tag) => tag.addEventListener('click', () => {
        const kind = tag.dataset.nb, bid = tag.dataset.nbid;
        if (kind === 'plot') p.activateView(VIEW_PLOTS);
        else { const e = p.entityById(bid); if (e) new EntityDetailModal(this.app, p, e).open(); }
      }));
    });
  }
}

/* Create/edit a line (track): name + axis (time/location/emotion) + view + whole-line links */
class TrackModal extends Modal {
  constructor(app, plugin, track) { super(app); this.p = plugin; this.t = track; this.binds = track ? (track.bindings || []).slice() : []; }
  onOpen() {
    const { contentEl } = this, p = this.p, t = this.t, isNew = !t;
    contentEl.createEl('h3', { text: (isNew ? 'New' : 'Edit') + 'Line (time / location / emotion)' });
    const name = contentEl.createEl('input'); name.type = 'text'; name.placeholder = 'Line name (renamable, e.g. A character\'s action trail / Royal capital geography line / Protagonist emotion curve)'; name.style.width = '100%';
    if (t) name.value = t.name;

    contentEl.createEl('p', { text: '① Line type (just one, or several for comparison)' }).style.cssText = 'font-weight:600;margin:12px 0 5px';
    let axis = t ? t.axis : 'time';
    const axisBtns = contentEl.createDiv(); axisBtns.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap';
    const axisBtnsArr = [];
    const namePresets = contentEl.createDiv(); namePresets.style.cssText = 'margin-top:6px;display:flex;gap:5px;flex-wrap:wrap';
    const renderPresets = () => {
      namePresets.empty();
      namePresets.createSpan({ text: 'Quick names: ' }).style.cssText = 'font-size:10px;color:var(--text-muted)';
      (TRACK_NAME_PRESETS[axis] || []).forEach((s) => {
        const b = namePresets.createEl('button', { text: s }); b.className = 'nws-btn sm';
        b.addEventListener('click', () => { name.value = s; });
        namePresets.appendChild(b);
      });
    };
    TRACK_AXES.forEach((a) => {
      const b = axisBtns.createEl('button', { text: a.emoji + ' ' + a.name });
      b.className = 'nws-fbtn' + (a.key === axis ? ' on' : ''); axisBtnsArr.push(b);
      b.addEventListener('click', () => {
        axis = a.key; axisBtnsArr.forEach((x) => x.removeClass('on')); b.addClass('on');
        if (isNew && !name.value.trim()) name.value = a.name;
        if (axis === 'emotion' && view === 'event') { view = 'emotion'; viewBtnsArr.forEach((x, i) => x.removeClass('on')); const vb = viewBtnsArr[TRACK_VIEWS.findIndex((v) => v.key === 'emotion')]; if (vb) vb.addClass('on'); hint.textContent = trackViewDef('emotion').hint; }
        renderPresets();
      });
    });

    contentEl.createEl('p', { text: '② View (decides node naming and content hints)' }).style.cssText = 'font-weight:600;margin:12px 0 5px';
    let view = t ? t.view : 'event';
    const viewBtns = contentEl.createDiv(); viewBtns.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap';
    const viewBtnsArr = [];
    TRACK_VIEWS.forEach((v) => {
      const b = viewBtns.createEl('button', { text: v.emoji + ' ' + v.name });
      b.className = 'nws-fbtn' + (v.key === view ? ' on' : ''); viewBtnsArr.push(b);
      b.addEventListener('click', () => { view = v.key; viewBtnsArr.forEach((x) => x.removeClass('on')); b.addClass('on'); hint.textContent = v.hint; });
    });
    const hint = contentEl.createDiv('nws-tpl-hint'); hint.style.cssText = 'font-size:10px;color:var(--text-muted);margin-top:8px;line-height:1.6';
    hint.textContent = trackViewDef(view).hint;
    renderPresets();

    /* ③ Whole-line links: who/what the line revolves around */
    contentEl.createEl('p', { text: '③ Linked target (who/what the line revolves around, optional)' }).style.cssText = 'font-weight:600;margin:12px 0 5px';
    const bindBox = contentEl.createDiv('nws-selbox');
    const renderBinds = () => {
      bindBox.empty();
      this.binds.forEach((b) => {
        const chip = bindBox.createEl('span', { text: (b.kind === 'plot' ? '🧩' : typeEmoji(b.type || b.kind)) + ' ' + (b.name || b.id) + ' ×' });
        chip.className = 'nws-bind'; chip.style.cursor = 'pointer';
        chip.addEventListener('click', () => { this.binds = this.binds.filter((x) => !(x.id === b.id && x.kind === b.kind)); renderBinds(); });
      });
      const add = bindBox.createEl('button', { text: '＋ Link character / plot / lore' }); add.className = 'nws-btn sm';
      add.addEventListener('click', () => new LineBindModal(this.app, p, (pick) => {
        if (!this.binds.some((x) => x.id === pick.id && x.kind === pick.kind)) { this.binds.push(pick); renderBinds(); }
      }).open());
    };
    renderBinds();

    const row = contentEl.createDiv(); row.style.cssText = 'margin-top:14px;text-align:right';
    const ok = row.createEl('button', { text: isNew ? 'Create line' : 'Save' }); ok.className = 'mod-cta';
    ok.addEventListener('click', async () => {
      const fields = { name: name.value.trim() || trackAxisDef(axis).name, axis, view, bindings: this.binds };
      if (isNew) await p.addTrack(fields); else await p.updateTrack(t.id, fields);
      this.close();
    });
    setTimeout(() => name.focus(), 30);
  }
  onClose() { this.contentEl.empty(); }
}

/* Standalone entry for track-level link selection (opens when clicking 🔗 in the list) */
class TrackBindModal extends Modal {
  constructor(app, plugin, track) { super(app); this.p = plugin; this.t = track; this.binds = (track.bindings || []).slice(); }
  onOpen() {
    const p = this.p, { contentEl } = this;
    contentEl.createEl('h3', { text: 'Linked targets · ' + this.t.name });
    contentEl.createEl('div', { text: 'The whole line revolves around these targets (e.g. linking a timeline to a character = that character\'s trail). Nodes can still be linked individually.' }).style.cssText = 'font-size:11px;color:var(--text-muted);margin-bottom:8px;line-height:1.6';
    const bindBox = contentEl.createDiv('nws-selbox');
    const render = () => {
      bindBox.empty();
      this.binds.forEach((b) => {
        const chip = bindBox.createEl('span', { text: (b.kind === 'plot' ? '🧩' : typeEmoji(b.type || b.kind)) + ' ' + (b.name || b.id) + ' ×' });
        chip.className = 'nws-bind'; chip.style.cursor = 'pointer';
        chip.addEventListener('click', () => { this.binds = this.binds.filter((x) => !(x.id === b.id && x.kind === b.kind)); render(); });
      });
      const add = bindBox.createEl('button', { text: '＋ Link' }); add.className = 'nws-btn sm';
      add.addEventListener('click', () => new LineBindModal(this.app, p, (pick) => {
        if (!this.binds.some((x) => x.id === pick.id && x.kind === pick.kind)) { this.binds.push(pick); render(); }
      }).open());
    };
    render();
    const row = contentEl.createDiv(); row.style.cssText = 'margin-top:14px;text-align:right';
    const ok = row.createEl('button', { text: 'Save links' }); ok.className = 'mod-cta';
    ok.addEventListener('click', async () => { await p.updateTrack(this.t.id, { bindings: this.binds }); this.close(); });
  }
  onClose() { this.contentEl.empty(); }
}

/* ================= Modals ================= */
class InputModal extends Modal {
  constructor(app, title, placeholder, onSubmit, initVal) { super(app); this.titleText = title; this.ph = placeholder; this.onSubmit = onSubmit; this.initVal = initVal; }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: this.titleText });
    const inp = contentEl.createEl('input');
    inp.type = 'text'; inp.placeholder = this.ph || ''; inp.style.width = '100%';
    if (this.initVal != null) inp.value = this.initVal;
    else if (this.ph) inp.value = this.ph;
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { this.onSubmit(inp.value); this.close(); } });
    const row = contentEl.createDiv(); row.style.cssText = 'margin-top:12px;text-align:right';
    const ok = row.createEl('button', { text: 'OK' }); ok.className = 'mod-cta';
    ok.addEventListener('click', () => { this.onSubmit(inp.value); this.close(); });
    setTimeout(() => { inp.focus(); inp.select(); }, 30);
  }
  onClose() { this.contentEl.empty(); }
}

class ColorModal extends Modal {
  constructor(app, entity, onPick) { super(app); this.e = entity; this.onPick = onPick; }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: 'Pick a highlight color for "' + (this.e ? this.e.name : '') + '"' });
    contentEl.createEl('div', { text: 'Pick a color = colored bold in the body; pick "No color" = bold + underline.' }).style.cssText = 'font-size:11px;color:var(--text-muted);margin-bottom:8px';
    PALETTE.forEach((c, i) => {
      const b = contentEl.createEl('button');
      b.style.cssText = 'width:30px;height:30px;border-radius:50%;border:2px solid ' + c + ';background:' + c + ';margin:6px;';
      b.title = PALETTE_NAMES[i];
      b.addEventListener('click', () => { this.onPick(i); this.close(); });
    });
    const none = contentEl.createEl('button', { text: 'No color (bold + underline)' });
    none.className = 'nws-btn'; none.style.cssText = 'display:block;margin-top:8px';
    none.addEventListener('click', () => { this.onPick(-1); this.close(); });
  }
  onClose() { this.contentEl.empty(); }
}

class TypePickModal extends Modal {
  constructor(app, types, isOutline, onPick) { super(app); this.types = types; this.isOutline = isOutline; this.onPick = onPick; }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: 'Choose a type' });
    this.types.forEach((t) => {
      const b = contentEl.createEl('button', { text: typeEmoji(t, this.isOutline) + ' ' + t });
      b.style.cssText = 'margin:4px 6px 4px 0;padding:6px 12px;';
      b.addEventListener('click', () => { this.onPick(t); this.close(); });
    });
  }
  onClose() { this.contentEl.empty(); }
}

class OutlineCreateModal extends Modal {
  constructor(app, plugin, presetType) { super(app); this.p = plugin; this.preset = presetType; }
  onOpen() {
    const { contentEl } = this, p = this.p;
    contentEl.createEl('h3', { text: 'New outline · pick a type first' });
    const desc = contentEl.createEl('div', { text: '① Pick an outline type (each has its own template) → ② Enter a title → ③ Create. Creating generates a same-name md note under Outline/ pre-filled with the template; fill in each item, and link targets if needed.' });
    desc.style.cssText = 'font-size:11px;color:var(--text-muted);line-height:1.6;margin-bottom:10px';

    /* ① Pick a type first */
    contentEl.createEl('p', { text: '① Pick an outline type' }).style.cssText = 'font-weight:600;margin:0 0 5px';
    const typeBtns = contentEl.createDiv(); typeBtns.style.cssText = 'display:flex;gap:5px;flex-wrap:wrap';
    let chosen = (this.preset && p.data.outlineTypes.indexOf(this.preset) >= 0) ? this.preset : null;
    let activeBtn = null;
    const hint = contentEl.createDiv('nws-otpl-hint');
    hint.style.cssText = 'font-size:10px;color:var(--text-muted);margin:8px 0;line-height:1.7;padding:8px;border-radius:6px;background:var(--background-secondary)';
    hint.textContent = 'After picking a type, its template fields show here.';
    const syncHint = () => {
      if (!chosen) { hint.textContent = 'Pick an outline type first.'; return; }
      hint.innerHTML = '<b>' + outlineEmoji(chosen) + ' ' + escapeHtml(chosen) + ' template</b><br>' +
        outlineTemplateFields(chosen).map((f) => '· ' + escapeHtml(f)).join('<br>');
    };
    p.data.outlineTypes.forEach((t) => {
      const b = typeBtns.createEl('button', { text: outlineEmoji(t) + ' ' + t });
      b.className = 'nws-fbtn';
      b.addEventListener('click', () => {
        if (activeBtn) activeBtn.removeClass('on'); b.addClass('on'); activeBtn = b;
        chosen = t; syncHint();
        if (inpWrap.style.display === 'none') inpWrap.style.display = '';
        inp.focus();
      });
      if (chosen === t) { b.addClass('on'); activeBtn = b; }
    });

    /* ② Title (shown after a type is picked, emphasizing the order) */
    const inpWrap = contentEl.createDiv(); inpWrap.style.cssText = chosen ? '' : 'display:none';
    inpWrap.createEl('p', { text: '② Outline title (will be the file name)' }).style.cssText = 'font-weight:600;margin:10px 0 5px';
    const inp = inpWrap.createEl('input'); inp.type = 'text'; inp.placeholder = 'e.g. Chapter 1 · A Visitor on a Rainy Night'; inp.style.width = '100%';
    syncHint();

    const row = contentEl.createDiv(); row.style.cssText = 'margin-top:12px;text-align:right';
    const ok = row.createEl('button', { text: '③ Create & generate template note' }); ok.className = 'mod-cta';
    const submit = async () => {
      if (!chosen) { new Notice('Pick an outline type first'); return; }
      if (!inp.value.trim()) { new Notice('Enter an outline title'); return; }
      const o = await p.addOutline(inp.value.trim(), chosen);
      this.close();
      if (o) { new Notice('Outline created: ' + o.title + '(' + chosen + ' template)'); p.openOutlineFile(o.id); }
    };
    ok.addEventListener('click', submit);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    if (chosen) setTimeout(() => inp.focus(), 30);
  }
  onClose() { this.contentEl.empty(); }
}

class OutlineEditModal extends Modal {
  constructor(app, plugin, outline) { super(app); this.p = plugin; this.o = outline; }
  onOpen() {
    const { contentEl } = this, p = this.p, o = this.o;
    if (!o) { this.close(); return; }
    contentEl.createEl('h3', { text: 'Edit outline · ' + o.title });
    const title = contentEl.createEl('input'); title.type = 'text'; title.value = o.title; title.style.width = '100%';

    const typeRow = contentEl.createDiv(); typeRow.style.cssText = 'margin-top:10px';
    const typeSpan = typeRow.createSpan({ text: 'Type: ' + outlineEmoji(o.type) + ' ' + o.type });
    const typeBtn = typeRow.createEl('button', { text: 'Change type' }); typeBtn.className = 'nws-btn sm'; typeBtn.style.marginLeft = '8px';
    let chosen = o.type;
    const tplHint = contentEl.createDiv('nws-otpl-hint'); tplHint.style.cssText = 'font-size:10px;color:var(--text-muted);margin-top:6px;line-height:1.6';
    tplHint.textContent = 'Template fields: ' + outlineTemplateFields(chosen).join(' · ');
    typeBtn.addEventListener('click', () => new TypePickModal(this.app, p.data.outlineTypes, true, (t) => {
      chosen = t; typeSpan.textContent = 'Type: ' + outlineEmoji(t) + ' ' + t; tplHint.textContent = 'Template fields: ' + outlineTemplateFields(t).join(' · ');
    }).open());

    /* Tags */
    contentEl.createEl('p', { text: 'Tags (comma-separated)' }).style.cssText = 'font-weight:600;margin-top:10px;margin-bottom:5px';
    const tags = contentEl.createEl('input'); tags.type = 'text'; tags.value = (o.tags || []).join(', '); tags.style.width = '100%';
    /* Color */
    contentEl.createEl('p', { text: 'Color' }).style.cssText = 'font-weight:600;margin-top:10px;margin-bottom:5px';
    let color = o.color == null ? 3 : o.color;
    const colorRow = contentEl.createDiv(); colorRow.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap';
    let cbtn = [];
    PALETTE.forEach((c, i) => {
      const b = colorRow.createEl('button');
      b.style.cssText = 'width:24px;height:24px;border-radius:50%;border:' + (i === color ? '3px solid var(--text-normal)' : '2px solid ' + c) + ';background:' + c + ';cursor:pointer';
      b.addEventListener('click', () => { color = i; cbtn.forEach((x, j) => x.style.border = (j === i ? '3px solid var(--text-normal)' : '2px solid ' + PALETTE[j])); });
      cbtn.push(b);
    });

    contentEl.createEl('p', { text: 'Description / Key points' }).style.cssText = 'font-weight:600;margin-top:10px;margin-bottom:5px';
    const desc = contentEl.createEl('textarea'); desc.value = o.desc || ''; desc.style.cssText = 'width:100%;height:80px';

    const row = contentEl.createDiv(); row.style.cssText = 'margin-top:12px;text-align:right';
    const openFile = row.createEl('button', { text: '📄 Open file' }); openFile.className = 'nws-btn'; openFile.style.marginRight = '8px';
    openFile.addEventListener('click', () => { this.close(); p.openOutlineFile(o.id); });
    const ok = row.createEl('button', { text: 'Save' }); ok.className = 'mod-cta';
    ok.addEventListener('click', async () => {
      const tg = tags.value.split(/[、,，]/).map((x) => x.trim()).filter(Boolean);
      await p.updateOutline(o.id, { title: title.value.trim() || o.title, type: chosen, tags: tg, color, desc: desc.value });
      new Notice('Outline saved and synced to file'); this.close();
    });
  }
  onClose() { this.contentEl.empty(); }
}

/* Plot edit modal: name / four stages / linked characters / chapter range / tags-color-notes */
class PlotModal extends Modal {
  constructor(app, plugin, plot) { super(app); this.p = plugin; this.plot = plot; }
  onOpen() {
    const p = this.p, pl = this.plot, { contentEl } = this;
    const isNew = !pl;
    contentEl.createEl('h3', { text: isNew ? 'New plot' : 'Edit plot · ' + pl.name });
    const name = contentEl.createEl('input'); name.type = 'text'; name.placeholder = 'Plot name'; name.style.width = '100%';
    if (pl) name.value = pl.name;

    contentEl.createEl('p', { text: '① Plot arc (beginning / development / climax / resolution)' }).style.cssText = 'font-weight:600;margin-top:12px;margin-bottom:6px';
    const stageInputs = {};
    PLOT_STAGES.forEach((s) => {
      const row = contentEl.createDiv(); row.style.cssText = 'margin-bottom:6px';
      row.createSpan({ text: s.emoji + ' ' + s.label + ': ' }).style.cssText = 'display:inline-block;width:64px;font-size:11px';
      const ta = row.createEl('textarea'); ta.style.cssText = 'width:calc(100% - 70px);height:38px;vertical-align:top';
      ta.placeholder = s.label + 'Key points…';
      if (pl && pl.stages) ta.value = pl.stages[s.key] || '';
      stageInputs[s.key] = ta;
    });

    contentEl.createEl('p', { text: '② Link characters' }).style.cssText = 'font-weight:600;margin-top:12px;margin-bottom:6px';
    let selRoles = pl ? (pl.roles || []).slice() : [];
    const roleBox = contentEl.createDiv('nws-selbox');
    const renderRoles = () => {
      roleBox.empty();
      selRoles.forEach((r) => {
        const chip = roleBox.createEl('span', { text: '👤 ' + (r.name || r.id) + ' ×' });
        chip.className = 'nws-bind'; chip.style.cursor = 'pointer';
        chip.addEventListener('click', () => { selRoles = selRoles.filter((x) => x.id !== r.id); renderRoles(); });
      });
      const add = roleBox.createEl('button', { text: '＋ Link character' }); add.className = 'nws-btn sm';
      add.addEventListener('click', () => new PlotBindPickModal(this.app, p, 'role', (pick) => {
        if (!selRoles.some((x) => x.id === pick.id)) { selRoles.push(pick); renderRoles(); }
      }).open());
    };
    renderRoles();

    contentEl.createEl('p', { text: '③ Chapters / chapter range' }).style.cssText = 'font-weight:600;margin-top:12px;margin-bottom:6px';
    let selChs = pl ? (pl.chapters || []).slice() : [];
    const chBox = contentEl.createDiv('nws-selbox');
    const renderChs = () => {
      chBox.empty();
      selChs.forEach((c) => {
        const chip = chBox.createEl('span', { text: '📄 ' + (c.name || c.id) + ' ×' });
        chip.className = 'nws-bind'; chip.style.cursor = 'pointer';
        chip.addEventListener('click', () => { selChs = selChs.filter((x) => x.id !== c.id); renderChs(); });
      });
      const add = chBox.createEl('button', { text: '＋ Link chapter' }); add.className = 'nws-btn sm';
      add.addEventListener('click', () => new PlotBindPickModal(this.app, p, 'chapter', (pick) => {
        if (!selChs.some((x) => x.id === pick.id)) { selChs.push(pick); renderChs(); }
      }).open());
    };
    renderChs();

    contentEl.createEl('p', { text: '④ Tags / color / notes' }).style.cssText = 'font-weight:600;margin-top:12px;margin-bottom:6px';
    const tags = contentEl.createEl('input'); tags.type = 'text'; tags.placeholder = 'Tags, comma-separated'; tags.style.width = '100%';
    if (pl) tags.value = (pl.tags || []).join(', ');
    let chosenColor = pl ? pl.color : 3;
    const colorRow = contentEl.createDiv(); colorRow.style.cssText = 'margin-top:8px';
    colorRow.createSpan({ text: 'Color: ' }).style.cssText = 'font-size:11px';
    const colorBtns = [];
    PALETTE.forEach((c, i) => {
      const b = colorRow.createEl('button');
      b.style.cssText = 'width:22px;height:22px;border-radius:50%;border:2px solid ' + (i === chosenColor ? 'var(--text-normal)' : 'transparent') + ';background:' + c + ';margin-right:5px;cursor:pointer';
      b.title = PALETTE_NAMES[i];
      b.addEventListener('click', () => { chosenColor = i; colorBtns.forEach((x, j) => x.style.borderColor = j === i ? 'var(--text-normal)' : 'transparent'); });
      colorBtns.push(b);
    });
    contentEl.createEl('p', { text: 'Notes' }).style.cssText = 'margin-top:8px';
    const note = contentEl.createEl('textarea'); note.style.cssText = 'width:100%;height:52px'; note.placeholder = 'Extra notes…';
    if (pl) note.value = pl.note || '';

    const row = contentEl.createDiv(); row.style.cssText = 'margin-top:14px;text-align:right';
    const ok = row.createEl('button', { text: isNew ? 'Create' : 'Save' }); ok.className = 'mod-cta';
    ok.addEventListener('click', async () => {
      const fields = {
        name: name.value.trim() || 'Untitled Plot',
        stages: {}, roles: selRoles, chapters: selChs,
        tags: tags.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
        color: chosenColor, note: note.value
      };
      PLOT_STAGES.forEach((s) => { fields.stages[s.key] = stageInputs[s.key].value; });
      if (isNew) { await p.addPlot(fields); new Notice('Plot created'); }
      else { await p.updatePlot(pl.id, fields); new Notice('Plot saved'); }
      this.close();
    });
    setTimeout(() => name.focus(), 30);
  }
  onClose() { this.contentEl.empty(); }
}

/* Character or chapter picker for plots / dual lines */
class PlotBindPickModal extends Modal {
  constructor(app, plugin, kind, onPick) { super(app); this.p = plugin; this.kind = kind; this.onPick = onPick; this.q = ''; }
  onOpen() {
    const { contentEl } = this, p = this.p, kind = this.kind;
    contentEl.createEl('h3', { text: kind === 'role' ? 'Choose characters' : 'Choose chapters' });
    const inp = contentEl.createEl('input'); inp.type = 'text'; inp.placeholder = 'Search…'; inp.style.width = '100%';
    const list = contentEl.createDiv(); list.style.cssText = 'max-height:320px;overflow:auto;margin-top:8px';
    const render = () => {
      list.empty();
      const q = this.q.trim().toLowerCase();
      const items = kind === 'role'
        ? p.data.entities.filter((e) => (e.type === 'Character' || e.type === 'Character' || typeEmoji(e.type) === '👤')).map((e) => ({ id: e.id, name: '👤 ' + e.name, kind: 'role', type: e.type }))
        : p.allChapters().map((c) => ({ id: c.path, name: '📄 ' + c.volume + ' / ' + c.title, kind: 'chapter' }));
      items.filter((x) => !q || x.name.toLowerCase().indexOf(q) >= 0).forEach((it) => {
        const row = list.createDiv({ text: it.name });
        row.style.cssText = 'padding:7px 9px;border-radius:5px;cursor:pointer';
        row.addEventListener('click', () => { this.onPick(it); this.close(); });
        row.addEventListener('mouseenter', () => row.style.background = 'var(--background-modifier-hover)');
        row.addEventListener('mouseleave', () => row.style.background = '');
      });
      if (!list.children.length) list.createEl('div', { text: kind === 'role' ? '(no characters in the lore library yet — create them there first)' : '(no chapters in the manuscript yet)' }).style.cssText = 'font-size:11px;color:var(--text-muted);padding:8px';
    };
    inp.addEventListener('input', (e) => { this.q = e.target.value; render(); });
    render();
    setTimeout(() => inp.focus(), 30);
  }
  onClose() { this.contentEl.empty(); }
}

/* Dual-line node edit modal */
class LineNodeModal extends Modal {
  constructor(app, plugin, line, node) { super(app); this.p = plugin; this.line = line; this.node = node; this.binds = node ? (node.bindings || []).slice() : []; }
  onOpen() {
    const p = this.p, n = this.node, { contentEl } = this, isNew = !n;
    const track = p.trackById(this.line);
    const vd = trackViewDef((n && n.view) || (track && track.view) || 'event');
    contentEl.createEl('h3', { text: (isNew ? 'Add' : 'Edit') + vd.node + (track ? '(' + track.name + ')' : '') });
    const label = contentEl.createEl('input'); label.type = 'text'; label.placeholder = vd.node + 'Name'; label.style.width = '100%';
    if (n) label.value = n.label;
    const atEx = track && track.axis === 'emotion' ? 'Event development / East ferry / Ch.2 / Storm night (external condition)'
      : track && track.axis === 'space' ? 'East ferry crossing' : 'Chapter 2 / Year 1024';
    const at = contentEl.createEl('input'); at.type = 'text'; at.placeholder = vd.at + 'e.g. ' + atEx + ')'; at.style.width = '100%'; at.style.marginTop = '6px';
    if (n) at.value = n.at || '';

    contentEl.createEl('p', { text: (track && track.axis === 'emotion' ? 'Trigger (event / place / time period / external condition / character)' : 'Linked targets (characters / plots / clues / foreshadowing etc.)') }).style.cssText = 'font-weight:600;margin-top:12px;margin-bottom:6px';
    const bindBox = contentEl.createDiv('nws-selbox');
    const renderBinds = () => {
      bindBox.empty();
      this.binds.forEach((b) => {
        const em = b.kind === 'plot' ? '🧩' : (b.type ? typeEmoji(b.type) : '🔹');
        const chip = bindBox.createEl('span', { text: em + ' ' + (b.name || b.id) + ' ×' });
        chip.className = 'nws-bind'; chip.style.cursor = 'pointer';
        chip.addEventListener('click', () => { this.binds = this.binds.filter((x) => !(x.id === b.id && x.kind === b.kind)); renderBinds(); });
      });
      const add = bindBox.createEl('button', { text: '＋ Link' }); add.className = 'nws-btn sm';
      add.addEventListener('click', () => new LineBindModal(this.app, p, (pick) => {
        if (!this.binds.some((x) => x.id === pick.id && x.kind === pick.kind)) { this.binds.push(pick); renderBinds(); }
      }).open());
    };
    renderBinds();

    contentEl.createEl('p', { text: 'Content (write based on linked targets; leave empty to show the link hint)' }).style.cssText = 'font-weight:600;margin-top:12px;margin-bottom:6px';
    const contentTa = contentEl.createEl('textarea'); contentTa.style.cssText = 'width:100%;height:90px';
    contentTa.placeholder = 'Write here what happens to this ' + vd.node + '…';
    if (n) contentTa.value = n.content || '';

    const row = contentEl.createDiv(); row.style.cssText = 'margin-top:14px;text-align:right';
    const ok = row.createEl('button', { text: isNew ? 'Add' : 'Save' }); ok.className = 'mod-cta';
    ok.addEventListener('click', async () => {
      const fields = { label: label.value.trim() || vd.node, at: at.value.trim(), bindings: this.binds, content: contentTa.value };
      if (isNew) { fields.view = (track && track.view) || 'event'; await p.addLineNode(this.line, fields); }
      else await p.updateLineNode(n.id, fields);
      this.close();
    });
    setTimeout(() => label.focus(), 30);
  }
  onClose() { this.contentEl.empty(); }
}

/* Dual-line nodes: generic link picker (lore entities + plots) */
class LineBindModal extends Modal {
  constructor(app, plugin, onPick) { super(app); this.p = plugin; this.onPick = onPick; this.q = ''; }
  onOpen() {
    const { contentEl } = this, p = this.p;
    contentEl.createEl('h3', { text: 'Linked Items' });
    const inp = contentEl.createEl('input'); inp.type = 'text'; inp.placeholder = 'Search…'; inp.style.width = '100%';
    const list = contentEl.createDiv(); list.style.cssText = 'max-height:340px;overflow:auto;margin-top:8px';
    const render = () => {
      list.empty();
      const q = this.q.trim().toLowerCase();
      const section = (title, items) => {
        const arr = items.filter((x) => !q || x.name.toLowerCase().indexOf(q) >= 0);
        if (!arr.length) return;
        list.createEl('div', { text: title }).style.cssText = 'font-size:10px;color:var(--text-muted);margin:10px 0 4px;font-weight:600';
        arr.forEach((it) => {
          const row = list.createDiv();
          row.style.cssText = 'display:flex;gap:8px;padding:6px 8px;border-radius:5px;cursor:pointer';
          row.createSpan({ text: typeEmoji(it.type || it.kind) + ' ' + it.name });
          row.addEventListener('click', () => { this.onPick(it); this.close(); });
          row.addEventListener('mouseenter', () => row.style.background = 'var(--background-modifier-hover)');
          row.addEventListener('mouseleave', () => row.style.background = '');
        });
      };
      section('🧩 Plot', p.data.plots.map((pl) => ({ kind: 'plot', id: pl.id, name: pl.name, type: 'Storyline' })));
      LINE_BIND_KINDS.filter((k) => k !== 'Plot').forEach((k) => {
        const arr = p.data.entities.filter((e) => e.type === k);
        if (arr.length) section(typeEmoji(k) + ' ' + k, arr.map((e) => ({ kind: 'entity', id: e.id, name: e.name, type: e.type })));
      });
    };
    inp.addEventListener('input', (e) => { this.q = e.target.value; render(); });
    render();
    setTimeout(() => inp.focus(), 30);
  }
  onClose() { this.contentEl.empty(); }
}

/* Find & replace (current active file) */
class FindReplaceModal extends Modal {
  constructor(app, plugin) { super(app); this.p = plugin; this.caseSensitive = false; this.matches = []; this.idx = -1; }
  onOpen() {
    const { contentEl } = this, self = this;
    contentEl.createEl('h3', { text: 'Find & Replace · Current File' });
    const view = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
    this.editor = view && view.editor ? view.editor : null;
    if (!this.editor) { contentEl.createEl('p', { text: 'Open a Markdown file first.' }).style.color = 'var(--text-muted)'; return; }

    const findRow = contentEl.createDiv(); findRow.style.cssText = 'display:flex;gap:6px;margin-bottom:8px';
    const find = findRow.createEl('input'); find.type = 'text'; find.placeholder = 'Find…'; find.style.cssText = 'flex:1';
    const findNext = findRow.createEl('button', { text: 'Next' }); findNext.className = 'nws-btn';
    const prevBtn = findRow.createEl('button', { text: 'Previous' }); prevBtn.className = 'nws-btn';

    const replRow = contentEl.createDiv(); replRow.style.cssText = 'display:flex;gap:6px;margin-bottom:8px';
    const repl = replRow.createEl('input'); repl.type = 'text'; repl.placeholder = 'Replace with…'; repl.style.cssText = 'flex:1';
    const replOne = replRow.createEl('button', { text: 'Replace' }); replOne.className = 'nws-btn';
    const replAll = replRow.createEl('button', { text: 'Replace All' }); replAll.className = 'nws-btn pri';

    const optRow = contentEl.createDiv(); optRow.style.cssText = 'margin-bottom:6px';
    const caseBtn = optRow.createEl('button', { text: 'Aa Case sensitive: off' }); caseBtn.className = 'nws-btn sm';
    caseBtn.addEventListener('click', () => { self.caseSensitive = !self.caseSensitive; caseBtn.textContent = 'Aa Case: ' + (self.caseSensitive ? 'On' : 'Off'); self.scan(find.value); });
    const info = contentEl.createDiv('nws-fr-info'); info.style.cssText = 'font-size:11px;color:var(--text-muted);min-height:18px';

    const scan = () => { self.scan(find.value, info); };
    const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    find.addEventListener('input', scan);
    findNext.addEventListener('click', () => self.gotoMatch(1, info));
    prevBtn.addEventListener('click', () => self.gotoMatch(-1, info));
    replOne.addEventListener('click', () => {
      if (self.idx < 0) { self.scan(find.value, info); }
      if (self.idx >= 0 && self.matches[self.idx]) {
        const m = self.matches[self.idx];
        self.editor.replaceRange(repl.value, self.editor.offsetToPos(m.from), self.editor.offsetToPos(m.to));
        self.scan(find.value, info); self.gotoMatch(0, info);
      }
    });
    replAll.addEventListener('click', () => {
      const q = find.value; if (!q) return;
      const text = self.editor.getValue();
      const flags = self.caseSensitive ? 'g' : 'gi';
      const re = new RegExp(esc(q), flags);
      const newText = text.replace(re, repl.value);
      const count = (text.match(re) || []).length;
      if (count) { self.editor.setValue(newText); new Notice('Replaced ' + count + ' occurrence(s)'); }
      else new Notice('No matches found');
      self.scan(find.value, info);
    });
    this.findInput = find;
    setTimeout(() => find.focus(), 30);
  }
  scan(q, info) {
    this.matches = []; this.idx = -1;
    if (!this.editor || !q) { if (info) info.textContent = ''; return; }
    const text = this.editor.getValue();
    const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(esc(q), this.caseSensitive ? 'g' : 'gi');
    let m;
    while ((m = re.exec(text)) !== null) { this.matches.push({ from: m.index, to: m.index + m[0].length }); if (m[0].length === 0) re.lastIndex++; }
    if (info) info.textContent = this.matches.length ? ('Found ' + this.matches.length + ' matches') : 'No matches found';
  }
  gotoMatch(dir, info) {
    if (!this.matches.length) { if (info) info.textContent = 'No matches found'; return; }
    this.idx = (this.idx + dir + this.matches.length) % this.matches.length;
    const m = this.matches[this.idx];
    const from = this.editor.offsetToPos(m.from), to = this.editor.offsetToPos(m.to);
    this.editor.setSelection(from, to);
    this.editor.scrollIntoView(from, true);
    if (info) info.textContent = (this.idx + 1) + ' / ' + this.matches.length + ' occurrence(s)';
  }
  onClose() { this.contentEl.empty(); }
}

/* Lore quick-search picker (invoked by typing the trigger, inserts the lore name on pick) */
class SettingPickModal extends Modal {
  constructor(app, plugin, onPick, onCancel) { super(app); this.p = plugin; this.onPick = onPick; this.onCancel = onCancel; this.q = ''; }
  onOpen() {
    const { contentEl } = this, p = this.p;
    contentEl.createEl('h3', { text: 'Insert lore / plot' });
    const inp = contentEl.createEl('input'); inp.type = 'text'; inp.placeholder = 'Search lore library… (name / alias)'; inp.style.width = '100%';
    const list = contentEl.createDiv('nws-suggest-list');
    const render = () => {
      list.empty();
      const q = this.q.trim().toLowerCase();
      const all = [];
      p.data.plots.forEach((pl) => all.push({ kind: 'plot', type: 'Storyline', name: pl.name }));
      p.data.entities.forEach((e) => all.push({ kind: 'entity', type: e.type, name: e.name, aliases: e.aliases || [] }));
      const arr = all.filter((x) => !q || x.name.toLowerCase().indexOf(q) >= 0 || (x.aliases || []).some((a) => a.toLowerCase().indexOf(q) >= 0));
      arr.slice(0, 80).forEach((it) => {
        const row = list.createDiv('nws-suggest-row');
        row.createSpan({ text: (it.kind === 'plot' ? '🧩' : typeEmoji(it.type)) + ' ' + it.name });
        const t = row.createSpan({ text: it.kind === 'plot' ? 'Plot' : it.type }); t.style.cssText = 'margin-left:auto;font-size:10px;color:var(--text-muted)';
        row.addEventListener('click', () => { this.picked = true; this.onPick(it); this.close(); });
      });
      if (!list.children.length) list.createEl('div', { text: 'No match — close and keep typing' }).style.cssText = 'font-size:11px;color:var(--text-muted);padding:8px';
    };
    inp.addEventListener('input', (e) => { this.q = e.target.value; render(); });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { this.close(); }
      else if (e.key === 'Enter') { const first = list.querySelector('.nws-suggest-row'); if (first) first.click(); }
    });
    render();
    setTimeout(() => inp.focus(), 30);
  }
  onClose() { this.contentEl.empty(); if (!this.picked && this.onCancel) this.onCancel(); }
}

/* Idea processing modal: content / status / linked lore (plots, characters etc.) */
class InspirationEditModal extends Modal {
  constructor(app, plugin, note) { super(app); this.p = plugin; this.note = note; this.binds = note ? (note.bindings || []).slice() : []; }
  onOpen() {
    const p = this.p, n = this.note, { contentEl } = this, isNew = !n;
    contentEl.createEl('h3', { text: isNew ? 'New idea' : 'Process idea' });
    const contentTa = contentEl.createEl('textarea'); contentTa.style.cssText = 'width:100%;height:70px'; contentTa.placeholder = 'Idea content…';
    if (n) contentTa.value = n.content;

    contentEl.createEl('p', { text: '① Status' }).style.cssText = 'font-weight:600;margin-top:12px;margin-bottom:6px';
    let status = n ? (n.status || 'Pending') : 'Pending';
    const statusRow = contentEl.createDiv(); statusRow.style.cssText = 'display:inline-flex;gap:6px';
    const sBtns = [];
    ['Pending', 'Adopted', 'Dropped'].forEach((s) => {
      const b = statusRow.createEl('button', { text: s });
      b.className = 'nws-fbtn' + (s === status ? ' on' : '');
      b.addEventListener('click', () => { status = s; sBtns.forEach((x) => x.removeClass('on')); b.addClass('on'); });
      sBtns.push(b);
    });

    contentEl.createEl('p', { text: '② Link to lore / plot (optional, says who this idea belongs to)' }).style.cssText = 'font-weight:600;margin-top:12px;margin-bottom:6px';
    const bindBox = contentEl.createDiv('nws-selbox');
    const renderBinds = () => {
      bindBox.empty();
      this.binds.forEach((b) => {
        const chip = bindBox.createEl('span', { text: (b.kind === 'plot' ? '🧩' : typeEmoji(b.type || b.kind)) + ' ' + (b.name || b.id) + ' ×' });
        chip.className = 'nws-bind'; chip.style.cursor = 'pointer';
        chip.addEventListener('click', () => { this.binds = this.binds.filter((x) => !(x.id === b.id && x.kind === b.kind)); renderBinds(); });
      });
      const add = bindBox.createEl('button', { text: '＋ Link (plot / character / clue…)' }); add.className = 'nws-btn sm';
      add.addEventListener('click', () => new LineBindModal(this.app, p, (pick) => {
        if (!this.binds.some((x) => x.id === pick.id && x.kind === pick.kind)) { this.binds.push(pick); renderBinds(); }
      }).open());
    };
    renderBinds();

    const row = contentEl.createDiv(); row.style.cssText = 'margin-top:14px;text-align:right';
    const ok = row.createEl('button', { text: isNew ? 'Save idea' : 'Save' }); ok.className = 'mod-cta';
    ok.addEventListener('click', async () => {
      const fields = { content: contentTa.value.trim() || '(empty idea)', status, bindings: this.binds };
      if (isNew) { await p.captureInspiration(fields.content, '', { status, bindings: this.binds }); }
      else { await p.updateNote(n.id, fields); new Notice('Idea updated'); }
      this.close();
    });
    setTimeout(() => contentTa.focus(), 30);
  }
  onClose() { this.contentEl.empty(); }
}

class EntityCreateModal extends Modal {
  constructor(app, plugin, presetLib, presetGroup, presetName) { super(app); this.p = plugin; this.preset = presetLib; this.presetGroup = presetGroup; this.presetName = presetName; }
  onOpen() {
    const { contentEl } = this, p = this.p;
    contentEl.createEl('h3', { text: 'New lore · pick a category' });
    const desc = contentEl.createEl('div', { text: 'Step 1 pick a category (each has its own template) → Step 2 enter a name → Create. A same-name md note is generated under Lore/<Category>/ — just fill in the template. For writing styles or custom types pick "Standalone".' });
    desc.style.cssText = 'font-size:11px;color:var(--text-muted);line-height:1.6;margin-bottom:10px';

    /* ① Category (v2.6 big-category edition: no second-level libraries; if a specific library came in from the context menu, auto-file under its category and reuse that library's template) */
    contentEl.createEl('p', { text: '① Pick a category' }).style.cssText = 'font-weight:600;margin:0 0 5px';
    const groupRow = contentEl.createDiv(); groupRow.style.cssText = 'display:flex;gap:5px;flex-wrap:wrap';
    /* When presetLib is passed, locate its category */
    let chosenGroup = null, presetLib = this.preset && LIB_BY_NAME[this.preset] ? this.preset : null;
    if (presetLib) chosenGroup = groupOfLib(presetLib);
    if (!chosenGroup && this.presetGroup && GROUP_BY_NAME[this.presetGroup]) chosenGroup = this.presetGroup;
    let activeGroupBtn = null;
    const customWrap = contentEl.createDiv('nws-custom-type'); customWrap.style.cssText = 'margin-top:8px;display:none';
    customWrap.createSpan({ text: 'Custom type name: ' }).style.cssText = 'font-size:11px';
    const customInp = customWrap.createEl('input'); customInp.type = 'text'; customInp.placeholder = 'e.g. Artifact, Technique, Divine Skill…'; customInp.style.cssText = 'width:100%;margin-top:4px';
    const hint = contentEl.createDiv('nws-tpl-hint'); hint.style.cssText = 'font-size:10px;color:var(--text-muted);margin-top:8px;line-height:1.6';

    /* The library actually used by this entry under each category (template source): presetLib first, otherwise the category's first library */
    let chosen = presetLib || null;
    const syncHint = () => {
      if (!chosen) chosen = libsOfGroup(chosenGroup)[0];
      const lib = LIB_BY_NAME[chosen];
      const fields = (lib && lib.fields && lib.fields.length) ? lib.fields : groupFields(chosenGroup);
      hint.textContent = 'Template fields: ' + fields.join(' · ');
      customWrap.style.display = (chosenGroup === 'Standalone') ? '' : 'none';
    };
    ENTITY_GROUPS.forEach((g) => {
      const b = groupRow.createEl('button', { text: g.emoji + ' ' + g.name });
      const on = g.name === chosenGroup;
      b.className = 'nws-fbtn' + (on ? ' on' : '');
      if (on) activeGroupBtn = b;
      b.addEventListener('click', () => {
        if (activeGroupBtn) activeGroupBtn.removeClass('on'); b.addClass('on'); activeGroupBtn = b;
        chosenGroup = g.name; chosen = null; syncHint();
      });
    });
    if (!chosenGroup) {
      chosenGroup = ENTITY_GROUPS[0].name; chosen = null;
      const firstBtn = groupRow.children && groupRow.children[0];
      if (firstBtn) { firstBtn.addClass('on'); activeGroupBtn = firstBtn; }
    }
    syncHint();

    const inp = contentEl.createEl('input'); inp.type = 'text'; inp.placeholder = '② Lore name (will be the file name)'; inp.style.cssText = 'width:100%;margin-top:12px';
    if (this.presetName) inp.value = this.presetName;

    /* Step 3: color (how it's colored in the body) */
    contentEl.createEl('p', { text: '③ Body highlight color (optional)' }).style.cssText = 'font-weight:600;margin:12px 0 5px';
    const colorRow = contentEl.createDiv(); colorRow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;align-items:center';
    let chosenColor = p.typeColor(chosen || 'Custom');
    const colorBtns = [];
    PALETTE.forEach((col, i) => {
      const cb = colorRow.createEl('button');
      cb.style.cssText = 'width:24px;height:24px;border-radius:50%;border:' + (i === chosenColor ? '3px solid var(--text-normal)' : '2px solid ' + col) + ';background:' + col + ';cursor:pointer';
      cb.title = PALETTE_NAMES[i] + '(colored bold in the body)';
      cb.addEventListener('click', () => { chosenColor = i; colorBtns.forEach((x, j) => x.style.border = (j === i ? '3px solid var(--text-normal)' : '2px solid ' + PALETTE[j])); noColorBtn.style.border = '2px solid var(--text-muted)'; });
      colorBtns.push(cb);
    });
    const noColorBtn = colorRow.createEl('button', { text: 'No color (bold + underline)' });
    noColorBtn.className = 'nws-btn sm';
    noColorBtn.addEventListener('click', () => { chosenColor = -1; colorBtns.forEach((x, j) => x.style.border = '2px solid ' + PALETTE[j]); noColorBtn.style.border = '2px solid var(--text-normal)'; });

    const row = contentEl.createDiv(); row.style.cssText = 'margin-top:12px;text-align:right';
    const ok = row.createEl('button', { text: 'Create & generate template note' }); ok.className = 'mod-cta';
    const submit = async () => {
      if (!inp.value.trim()) return;
      let type = chosen;
      if (chosenGroup === 'Standalone') {
        const cn = customInp.value.trim();
        if (cn) {
          type = cn;
          if (p.data.entityTypes.indexOf(cn) < 0) { p.data.entityTypes.push(cn); p.data.typeColors[cn] = 0; }
        } else type = 'Custom';
      }
      const e = await p.addEntity(inp.value.trim(), type, chosenGroup);
      if (e) { e.color = chosenColor; await p.writeEntityFile(e, false); await p.saveNow(); p.entityVersion++; p.refreshViews(); }
      this.close();
      if (e) { new Notice('Created Lore/' + groupFolderName(chosenGroup) + '/' + e.name + '.md'); p.openEntityFile(e.id); }
    };
    ok.addEventListener('click', submit);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    setTimeout(() => inp.focus(), 30);
  }
  onClose() { this.contentEl.empty(); }
}

/* Link picker */
class BindModal extends Modal {
  constructor(app, plugin, ownerKind, ownerId) { super(app); this.p = plugin; this.ownerKind = ownerKind; this.ownerId = ownerId; this.q = ''; }
  onOpen() {
    const { contentEl } = this, p = this.p;
    const owner = this.ownerKind === 'outline' ? p.outlineById(this.ownerId) : p.entityById(this.ownerId);
    if (!owner) { this.close(); return; }
    contentEl.createEl('h3', { text: 'Linked targets · ' + (owner.title || owner.name) });
    const hint = contentEl.createEl('div', { text: 'Click an entry to toggle its link. Can link chapters, lore (characters / plots / background etc.), and other outlines.' });
    hint.style.cssText = 'font-size:11px;color:var(--text-muted);margin-bottom:8px';
    const inp = contentEl.createEl('input'); inp.type = 'text'; inp.placeholder = 'Search…'; inp.style.width = '100%';
    const list = contentEl.createDiv(); list.style.cssText = 'max-height:340px;overflow:auto;margin-top:8px';
    const isBound = (kind, id) => (owner.bindings || []).some((b) => b.kind === kind && b.id === id);
    const render = () => {
      list.empty();
      const q = this.q.trim().toLowerCase();
      const section = (title, items) => {
        const arr = items.filter((x) => !q || x.name.toLowerCase().indexOf(q) >= 0);
        if (!arr.length) return;
        list.createEl('div', { text: title }).style.cssText = 'font-size:10px;color:var(--text-muted);margin:10px 0 4px;font-weight:600';
        arr.forEach((it) => {
          const on = isBound(it.kind, it.id);
          const row = list.createDiv();
          row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:5px;cursor:pointer;' + (on ? 'background:rgba(143,163,148,.18)' : '');
          row.createSpan({ text: (on ? '✅ ' : '⬜ ') + it.icon + ' ' + it.name });
          row.addEventListener('click', async () => { await p.toggleBinding(this.ownerKind, this.ownerId, { kind: it.kind, id: it.id, name: it.name }); render(); });
        });
      };
      section('📄 Chapters', p.allChapters().map((c) => ({ kind: 'chapter', id: c.path, name: c.volume + ' / ' + c.title, icon: '📄' })));
      section('🔗 Lore', p.data.entities.map((e) => ({ kind: 'entity', id: e.id, name: typeEmoji(e.type) + ' ' + e.name + '(' + e.type + ')', icon: '🔗' })));
      section('📋 Outline', p.data.outlines.filter((o) => o.id !== this.ownerId).map((o) => ({ kind: 'outline', id: o.id, name: typeEmoji(o.type, true) + ' ' + o.title, icon: '📋' })));
    };
    inp.addEventListener('input', (e) => { this.q = e.target.value; render(); });
    render();
  }
  onClose() { this.contentEl.empty(); }
}

/* Lore details: book-wide stats + per-chapter distribution + links + edit entry */
class EntityDetailModal extends Modal {
  constructor(app, plugin, entity) { super(app); this.p = plugin; this.e = entity; }
  onOpen() {
    const { contentEl } = this, p = this.p, e = this.e;
    if (!e) { this.close(); return; }
    const ag = p.aggregate();
    const pe = ag.perEntity[e.id] || { total: 0, chapters: {}, first: '—', last: '—' };
    contentEl.createEl('h3', { text: typeEmoji(e.type) + ' ' + e.name + ' · ' + (e.type || '') });
    contentEl.createEl('p', { text: e.desc || '(no description)' });
    const stats = contentEl.createDiv('nws-stat4');
    [['Book-wide: ', pe.total + ' times'], ['Chapters involved', Object.keys(pe.chapters).length + ' chapters'], ['First appearance', pe.first || '—'], ['Last seen', pe.last || '—']].forEach((kv) => {
      const c = stats.createDiv('nws-sc'); c.createDiv('nws-k').textContent = kv[0]; c.createDiv('nws-v').textContent = kv[1];
    });
    contentEl.createEl('h4', { text: 'Appearances per chapter' });
    const entries = Object.keys(pe.chapters).sort((a, b) => pe.chapters[b] - pe.chapters[a]);
    if (!entries.length) contentEl.createEl('div', { text: '(not appeared in the manuscript yet)' }).style.cssText = 'font-size:11px;color:var(--text-muted)';
    const max = Math.max(1, ...entries.map((k) => pe.chapters[k]));
    entries.forEach((path) => {
      const row = contentEl.createDiv('nws-dist');
      const title = (ag.chapters.find((c) => c.path === path) || {}).title || path;
      const n = row.createSpan('n'); n.textContent = title; n.setAttribute('title', path);
      const b = row.createSpan('b'), i = b.createEl('i'); i.style.width = (pe.chapters[path] / max * 100) + '%';
      row.createSpan('v').textContent = pe.chapters[path];
      row.style.cursor = 'pointer';
      row.addEventListener('click', () => { p.openChapterByPath(path); this.close(); });
    });
    const binds = e.bindings || [];
    contentEl.createEl('h4', { text: 'Linked targets (' + binds.length + ')' });
    if (binds.length) {
      const bwrap = contentEl.createDiv(); bwrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px';
      binds.forEach((b) => {
        const chip = bwrap.createEl('span', { text: (b.kind === 'chapter' ? '📄' : b.kind === 'entity' ? '🔗' : '📋') + ' ' + (b.name || b.id) });
        chip.className = 'nws-bind';
      });
    } else contentEl.createEl('div', { text: '(not linked)' }).style.cssText = 'font-size:11px;color:var(--text-muted)';

    const row = contentEl.createDiv('nws-row'); row.style.marginTop = '14px';
    const openFile = row.createEl('button', { text: '📄 Open lore file' }); openFile.className = 'nws-btn pri';
    openFile.addEventListener('click', () => { this.close(); p.openEntityFile(e.id); });
    const edit = row.createEl('button', { text: 'Edit metadata' }); edit.className = 'nws-btn'; edit.style.marginLeft = '8px';
    edit.addEventListener('click', () => { this.close(); new EntityEditModal(this.app, p, e).open(); });
    const bind = row.createEl('button', { text: '🔗 Manage links' }); bind.className = 'nws-btn'; bind.style.marginLeft = '8px';
    bind.addEventListener('click', () => { this.close(); new BindModal(this.app, p, 'entity', e.id).open(); });
    const del = row.createEl('button', { text: 'Delete' }); del.className = 'nws-btn'; del.style.marginLeft = '8px';
    del.addEventListener('click', () => { this.close(); p.deleteEntity(e.id); });
  }
  onClose() { this.contentEl.empty(); }
}

class EntityEditModal extends Modal {
  constructor(app, plugin, entity) { super(app); this.p = plugin; this.e = entity; }
  onOpen() {
    const { contentEl } = this, p = this.p, e = this.e;
    if (!e) { this.close(); return; }
    contentEl.createEl('h3', { text: 'Edit lore · ' + e.name });
    const name = contentEl.createEl('input'); name.type = 'text'; name.value = e.name; name.style.width = '100%';

    /* Two-level ownership: category → library */
    let chosenGroup = e.group || groupOfLib(e.type);
    let chosen = e.type;
    const selNote = contentEl.createDiv(); selNote.style.cssText = 'margin-top:10px;font-size:11px;color:var(--text-muted)';
    const refreshSelNote = () => { selNote.textContent = 'Category: ' + groupEmoji(chosenGroup) + ' ' + chosenGroup + ' / ' + ((LIB_BY_NAME[chosen] || {}).emoji || '🔹') + ' ' + chosen; };
    const gpRow = contentEl.createDiv(); gpRow.style.cssText = 'display:flex;gap:5px;flex-wrap:wrap;margin-top:6px';
    contentEl.createEl('p', { text: 'Category' }).style.cssText = 'font-weight:600;margin:10px 0 0';
    const libRow = contentEl.createDiv(); libRow.style.cssText = 'display:flex;gap:5px;flex-wrap:wrap;margin-top:6px';
    let activeG = null, activeL = null;
    const renderLibs = () => {
      libRow.empty();
      libsOfGroup(chosenGroup).forEach((l) => {
        const def = LIB_BY_NAME[l]; const b = libRow.createEl('button', { text: (def ? def.emoji + ' ' : '') + l });
        b.className = 'nws-fbtn' + (l === chosen ? ' on' : ''); if (l === chosen) activeL = b;
        b.addEventListener('click', () => { if (activeL) activeL.removeClass('on'); b.addClass('on'); activeL = b; chosen = l; refreshSelNote(); });
      });
    };
    ENTITY_GROUPS.forEach((g) => {
      const b = gpRow.createEl('button', { text: g.emoji + ' ' + g.name });
      b.className = 'nws-fbtn' + (g.name === chosenGroup ? ' on' : ''); if (g.name === chosenGroup) activeG = b;
      b.addEventListener('click', () => {
        if (activeG) activeG.removeClass('on'); b.addClass('on'); activeG = b;
        chosenGroup = g.name; const libs = libsOfGroup(chosenGroup); if (libs.indexOf(chosen) < 0) chosen = libs[0];
        renderLibs(); refreshSelNote();
      });
    });
    renderLibs(); refreshSelNote();

    contentEl.createEl('p', { text: 'Aliases (comma-separated; matches in the body get highlighted and counted)' });
    const aliases = contentEl.createEl('input'); aliases.type = 'text'; aliases.value = (e.aliases || []).join(', '); aliases.style.width = '100%';
    /* Color: keep current; adjust with 🎨 in the details view */
    contentEl.createEl('p', { text: 'Description' });
    const desc = contentEl.createEl('textarea'); desc.value = e.desc || ''; desc.style.cssText = 'width:100%;height:70px';
    const row = contentEl.createDiv(); row.style.cssText = 'margin-top:12px;text-align:right';
    const ok = row.createEl('button', { text: 'Save' }); ok.className = 'mod-cta';
    ok.addEventListener('click', async () => {
      const al = aliases.value.split(/[、,，]/).map((s) => s.trim()).filter(Boolean);
      await p.updateEntity(e.id, { name: name.value.trim() || e.name, type: chosen, group: chosenGroup, aliases: al, desc: desc.value });
      new Notice('Lore saved'); this.close();
    });
  }
  onClose() { this.contentEl.empty(); }
}

/* ================= v2.1 data center (heatmap / word stats) ================= */
class StatsView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.days = 365; this.gran = 'day'; }
  getViewType() { return VIEW_STATS; }
  getDisplayText() { return 'Studio · Data Center'; }
  getIcon() { return 'chart-no-axes-column'; }
  async onOpen() { this.render(); }
  render() {
    const p = this.plugin;
    const today = p.todayData();
    const pace = p.pacePerMinute();
    /* Overview cards */
    const cards = [
      ['Words today', fmt(today.words) + ' words', '📝'],
      ['Writing time', fmtDur(today.secs), '⏱️'],
      ['Focus time', fmtDur(today.focus), '🎯'],
      ['Live pace', pace + ' wpm', '⚡'],
    ].map((kv) => '<div class="nws-dc-card"><div class="k">' + kv[2] + ' ' + kv[0] + '</div><div class="v">' + kv[1] + '</div></div>').join('');
    /* Heatmap: switchable 84-day / 365-day */
    const heat = this.heatmap(p, this.days);
    const heatBtns = [84, 365].map((n) => '<button class="nws-fbtn' + (this.days === n ? ' on' : '') + '" data-heat="' + n + '">' + (n === 84 ? '3 months' : '1 year') + '</button>').join('');
    /* Chart 1 granularity dropdown: day / week / month */
    const granOpts = [['day', 'Daily words (last 30 days)'], ['week', 'Weekly words (last 12 weeks)'], ['month', 'Monthly words (last 12 months)']];
    const granSel = '<select class="dropdown nws-gran-sel">' + granOpts.map((o) => '<option value="' + o[0] + '"' + (this.gran === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select>';
    /* Daily detail: last 14 days */
    const rows = [];
    for (let i = 0; i < 14; i++) {
      const dt = new Date(); dt.setDate(dt.getDate() - i);
      const k = dateKey(dt);
      const d = Object.assign({ words: 0, secs: 0, focus: 0 }, p.data.daily[k] || {});
      const avg = d.secs > 0 ? Math.round(d.words / (d.secs / 60)) : 0;
      rows.push('<tr><td>' + k + (i === 0 ? ' <span class="nws-tag g">Today</span>' : '') + '</td>' +
        '<td>' + fmt(d.words) + '</td><td>' + fmtDur(d.secs) + '</td><td>' + fmtDur(d.focus) + '</td><td>' + avg + '</td></tr>');
    }
    /* Totals */
    const allDays = Object.keys(p.data.daily);
    const cumWords = allDays.reduce((s, k) => s + (p.data.daily[k].words || 0), 0);
    const cumFocus = allDays.reduce((s, k) => s + (p.data.daily[k].focus || 0), 0);

    const html =
      '<div class="nws-phead"><div class="nws-row"><div class="nws-ptitle">📊 Data Center</div><div class="nws-sp"></div>' +
      '<button class="nws-btn" data-act="pomodoro">🍅 Pomodoro</button>' +
      '<button class="nws-btn pri" data-act="focus">🎯 Focus Mode</button></div>' +
      '<div class="nws-psub">Total words written ' + fmt(cumWords) + ' · total focus ' + fmtDur(cumFocus) + ' · data updates live as you write and is stored locally</div></div>' +
      '<div class="nws-dc">' +
      '<div class="nws-dc-cards">' + cards + '</div>' +
      /* Chart 1: words (bars) + active writing time (line) on dual axes in one chart, switchable granularity */
      '<div class="nws-dc-sec"><h4>Words & Time' + granSel + ' <span class="nws-dc-hint">bars = words (left axis) · line = active writing time (right axis, min)</span></h4>' + this.comboChart(p, this.gran || 'day') + '</div>' +
      /* Chart 2: active writing time (separate chart) */
      '<div class="nws-dc-sec"><h4>Active writing time (last 14 days) <span class="nws-dc-hint">two-color bars: writing vs focus time</span></h4>' + this.durationChart(p, 14) + '</div>' +
      /* Time distribution */
      '<div class="nws-dc-sec"><h4>Time distribution <span class="nws-dc-hint">when you usually write · words by hour bucket</span></h4>' + this.timeDistribution(p) + '</div>' +
      /* Three KPI card groups */
      '<div class="nws-kpi-grid">' +
      '<div class="nws-kpi-col"><h4>Writing Consistency</h4>' + this.kpiStability(p) + '</div>' +
      '<div class="nws-kpi-col"><h4>Efficiency</h4>' + this.kpiEfficiency(p) + '</div>' +
      '<div class="nws-kpi-col"><h4>Goal Completion</h4>' + this.kpiGoals(p) + '</div>' +
      '</div>' +
      '<div class="nws-dc-sec"><h4>Lore Usage Top 10 <span class="nws-dc-hint">by book-wide appearances · click to open the lore note</span></h4>' + this.entityTop10(p) + '</div>' +
      '<div class="nws-dc-sec"><h4>Writing heatmap (last ' + (this.days === 84 ? '3 months' : '1 year') + ')' +
      '<span class="nws-heat-switch">' + heatBtns + '</span></h4>' + heat +
      '<div class="nws-heat-legend"><span>Less</span>' + [0, 1, 2, 3, 4].map((i) => '<i class="h' + i + '"></i>').join('') + '<span>More</span></div></div>' +
      '<div class="nws-dc-sec"><h4>Content updates · recent changes <span class="nws-dc-hint">chapters and lore notes, by modified time</span></h4>' + this.recentUpdates(p) + '</div>' +
      '<div class="nws-dc-sec"><h4>Daily word detail (last 14 days)</h4>' +
      '<table class="nws-dc-table"><thead><tr><th>Date</th><th>Words</th><th>Writing</th><th>Focus</th><th>Avg (wpm)</th></tr></thead><tbody>' + rows.join('') + '</tbody></table></div>' +
      '</div>';
    const root = setViewRoot(this, html);
    root.querySelector('[data-act="pomodoro"]').addEventListener('click', () => new FocusModal(this.app, p, 'pomodoro').open());
    root.querySelector('[data-act="focus"]').addEventListener('click', () => new FocusModal(this.app, p, 'focus').open());
    root.querySelectorAll('[data-heat]').forEach((b) => b.addEventListener('click', () => { this.days = Number(b.getAttribute('data-heat')) || 365; this.render(); }));
    root.querySelectorAll('[data-ent]').forEach((row) => row.addEventListener('click', () => {
      const id = row.getAttribute('data-ent'); if (id) p.openEntityFile(id);
    }));
    root.querySelectorAll('[data-open]').forEach((row) => row.addEventListener('click', () => {
      const path = row.getAttribute('data-open'); if (!path) return;
      const f = p.app.vault.getAbstractFileByPath(path);
      if (f) p.app.workspace.getLeaf('tab').openFile(f);
    }));
    const granEl = root.querySelector('.nws-gran-sel');
    if (granEl) granEl.addEventListener('change', (e) => { this.gran = e.target.value; this.render(); });
  }
  /* Granularity aggregation: day (last 30) / week (last 12, starting Monday) / month (last 12) → {k,w,secs,label} */
  aggSeries(p, gran) {
    const daily = p.data.daily || {};
    const arr = [];
    const push = (k, label, days) => {
      let w = 0, secs = 0, has = false;
      for (const kk of days) { const dd = daily[kk]; if (dd) { has = true; w += dd.words || 0; secs += dd.secs || 0; } }
      arr.push({ k, label, w, secs, has });
    };
    const keysBetween = (fromD, toD) => { const out = []; const d = new Date(fromD); while (d <= toD) { out.push(dateKey(d)); d.setDate(d.getDate() + 1); } return out; };
    const today = new Date(); today.setHours(0, 0, 0, 0);
    if (gran === 'month') {
      for (let i = 11; i >= 0; i--) {
        const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
        const end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
        push(dateKey(d).slice(0, 7), (d.getMonth() + 1) + ' mo', keysBetween(d, i === 0 ? today : end));
      }
    } else if (gran === 'week') {
      const monday = new Date(today); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
      for (let i = 11; i >= 0; i--) {
        const s = new Date(monday); s.setDate(s.getDate() - i * 7);
        const e = new Date(s); e.setDate(e.getDate() + 6);
        push(dateKey(s), (s.getMonth() + 1) + '/' + s.getDate() + ' wk', keysBetween(s, i === 0 ? today : e));
      }
    } else {
      this.dailySeries(p, 30).forEach((d) => { const dd = daily[d.k]; arr.push({ k: d.k, label: d.label, w: d.w, secs: (dd && dd.secs) || 0, has: !!dd }); });
    }
    return arr;
  }
  /* Chart 1 (merged): bars = words (left axis), line = active writing time (right axis, minutes) */
  comboChart(p, gran) {
    const data = this.aggSeries(p, gran);
    const W = 600, H = 170, PL = 40, PR = 44, PT = 16, PB = 22;
    const maxW = Math.max(500, ...data.map((d) => d.w));
    const maxS = Math.max(30, ...data.map((d) => d.secs / 60));
    const iw = W - PL - PR, ih = H - PT - PB;
    const n = data.length, step = iw / n, bw = Math.min(30, step * 0.6);
    const yW = (v) => PT + ih - (v / maxW) * ih;
    const yS = (v) => PT + ih - (v / maxS) * ih;
    /* Grid (4 ticks for the left-axis word count) */
    let grid = '';
    for (let g = 0; g <= 4; g++) {
      const gv = Math.round((maxW / 4) * g);
      const gy = yW(gv);
      grid += '<line x1="' + PL + '" y1="' + gy + '" x2="' + (W - PR) + '" y2="' + gy + '" stroke="var(--nws-line)" stroke-width="1"/>' +
        '<text x="' + (PL - 5) + '" y="' + (gy + 3) + '" text-anchor="end" font-size="9" fill="var(--nws-ink2)">' + (gv >= 10000 ? (gv / 10000) + 'w' : (gv >= 1000 ? (gv / 1000) + 'k' : gv)) + '</text>';
      const sv = Math.round((maxS / 4) * g);
      grid += '<text x="' + (W - PR + 5) + '" y="' + (gy + 3) + '" font-size="9" fill="#d09a30">' + sv + '</text>';
    }
    let bars = '';
    data.forEach((d, i) => {
      const bx = PL + i * step + (step - bw) / 2;
      const bh = Math.max(d.w > 0 ? 2 : 0, (d.w / maxW) * ih);
      bars += '<rect x="' + (bx).toFixed(1) + '" y="' + yW(d.w).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + bh.toFixed(1) + '" rx="3" fill="var(--nws-accent)" opacity=".6"><title>' + d.k + ': ' + fmt(d.w) + ' words</title></rect>';
    });
    const pts = data.map((d, i) => (PL + i * step + step / 2).toFixed(1) + ',' + yS(d.secs / 60).toFixed(1)).join(' ');
    let xl = '';
    const tick = gran === 'day' ? 7 : (gran === 'week' ? 2 : 1);
    data.forEach((d, i) => { if (i % tick === 0 || i === n - 1) xl += '<text x="' + (PL + i * step + step / 2) + '" y="' + (H - 6) + '" text-anchor="middle" font-size="9" fill="var(--nws-ink2)">' + d.label + '</text>'; });
    const totW = data.reduce((s, d) => s + d.w, 0);
    const totS = data.reduce((s, d) => s + d.secs, 0);
    return '<div class="nws-chart-wrap"><svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="width:100%;height:' + H + 'px">' +
      grid + bars +
      '<polyline points="' + pts + '" fill="none" stroke="#d09a30" stroke-width="2" stroke-linejoin="round"/>' +
      data.map((d, i) => '<circle cx="' + (PL + i * step + step / 2) + '" cy="' + yS(d.secs / 60) + '" r="2.2" fill="#d09a30"><title>' + d.k + ': ' + fmtDur(d.secs) + '</title></circle>').join('') +
      xl + '</svg>' +
      '<div class="nws-chart-sum">Total <b>' + fmt(totW) + '</b> words · active writing <b>' + fmtDur(totS) + '</b> · avg pace <b>' + (totS > 0 ? Math.round(totW / (totS / 60)) : 0) + '</b> wpm</div></div>';
  }
  /* Chart 2 (separate): active writing time over the last 14 days — writing vs focus, two bars */
  durationChart(p, n) {
    const daily = p.data.daily || {};
    const days = [];
    for (let i = n - 1; i >= 0; i--) {
      const dt = new Date(); dt.setDate(dt.getDate() - i);
      const k = dateKey(dt);
      const dd = daily[k] || {};
      days.push({ k, label: (dt.getMonth() + 1) + '/' + dt.getDate(), secs: dd.secs || 0, focus: dd.focus || 0 });
    }
    const W = 600, H = 150, PL = 40, PR = 10, PT = 16, PB = 22;
    const max = Math.max(600, ...days.map((d) => Math.max(d.secs, d.focus)));
    const iw = W - PL - PR, ih = H - PT - PB;
    const step = iw / n, bw = Math.min(11, step * 0.34);
    let grid = '';
    for (let g = 0; g <= 4; g++) {
      const gv = Math.round((max / 4) * g), gy = PT + ih - (gv / max) * ih;
      grid += '<line x1="' + PL + '" y1="' + gy + '" x2="' + (W - PR) + '" y2="' + gy + '" stroke="var(--nws-line)" stroke-width="1"/>' +
        '<text x="' + (PL - 5) + '" y="' + (gy + 3) + '" text-anchor="end" font-size="9" fill="var(--nws-ink2)">' + (gv >= 3600 ? (gv / 3600) + 'h' : Math.round(gv / 60) + 'm') + '</text>';
    }
    let bars = '';
    days.forEach((d, i) => {
      const cx = PL + i * step + step / 2;
      const h1 = Math.max(d.secs > 0 ? 2 : 0, (d.secs / max) * ih);
      const h2 = Math.max(d.focus > 0 ? 2 : 0, (d.focus / max) * ih);
      bars += '<rect x="' + (cx - bw - 1).toFixed(1) + '" y="' + (PT + ih - h1).toFixed(1) + '" width="' + bw + '" height="' + h1.toFixed(1) + '" rx="2" fill="var(--nws-accent)" opacity=".75"><title>' + d.k + ' writing: ' + fmtDur(d.secs) + '</title></rect>';
      bars += '<rect x="' + (cx + 1).toFixed(1) + '" y="' + (PT + ih - h2).toFixed(1) + '" width="' + bw + '" height="' + h2.toFixed(1) + '" rx="2" fill="#6287A8" opacity=".85"><title>' + d.k + ' focus: ' + fmtDur(d.focus) + '</title></rect>';
      if (i % 3 === 0 || i === n - 1) bars += '<text x="' + cx + '" y="' + (H - 6) + '" text-anchor="middle" font-size="9" fill="var(--nws-ink2)">' + d.label + '</text>';
    });
    const totS = days.reduce((s, d) => s + d.secs, 0), totF = days.reduce((s, d) => s + d.focus, 0);
    return '<div class="nws-chart-wrap"><svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="width:100%;height:' + H + 'px">' + grid + bars + '</svg>' +
      '<div class="nws-chart-sum"><i class="nws-lg-dot" style="background:var(--nws-accent)"></i> Writing <b>' + fmtDur(totS) + '</b>　<i class="nws-lg-dot" style="background:#6287A8"></i> Focus <b>' + fmtDur(totF) + '</b></div></div>';
  }
  /* Time distribution: late night / morning / afternoon / evening + weekday/weekend */
  timeDistribution(p) {
    const daily = p.data.daily || {};
    const seg = [0, 0, 0, 0]; // late night 0-6, morning 6-12, afternoon 12-18, evening 18-24
    let wk = 0, we = 0, hasHours = false;
    Object.keys(daily).forEach((k) => {
      const dd = daily[k];
      if (Array.isArray(dd.hours)) {
        hasHours = true;
        for (let h = 0; h < 24; h++) seg[Math.floor(h / 6)] += dd.hours[h] || 0;
      }
      wk += dd.wk || 0; we += dd.we || 0;
    });
    if (!hasHours && wk === 0 && we === 0) return '<div class="nws-dc-empty">Time distribution starts recording now — words accumulate by hour bucket as you write; come back after a session and there will be data.</div>';
    const names = ['🌙 Late night 0-6', '🌅 Morning 6-12', '☀️ Afternoon 12-18', '🌃 Evening 18-24'];
    const maxSeg = Math.max(1, ...seg);
    const rows = seg.map((v, i) => '<div class="nws-seg-row"><span class="nm">' + names[i] + '</span>' +
      '<span class="bar"><i style="width:' + Math.round((v / maxSeg) * 100) + '%"></i></span>' +
      '<span class="ct">' + fmt(v) + ' words</span></div>').join('');
    const wkw = wk + we > 0 ? Math.round((wk / (wk + we)) * 100) : 50;
    const dowRow = '<div class="nws-seg-row dow"><span class="nm">Weekdays</span><span class="bar split"><i style="width:' + wkw + '%"></i></span><span class="nm2">Weekend</span></div>' +
      '<div class="nws-seg-sum">Weekdays ' + fmt(wk) + ' words (' + wkw + '%) · weekend ' + fmt(we) + ' words (' + (100 - wkw) + '%)</div>';
    const best = seg.indexOf(Math.max(...seg));
    return '<div class="nws-time-dist">' + rows + dowRow +
      '<div class="nws-chart-sum">You write most in <b>' + names[best].replace(/^\S+\s/, '') + '</b></div></div>';
  }
  /* KPI card assembly */
  kpiRow(label, value, sub) {
    return '<div class="nws-kpi"><div class="l">' + label + '</div><div class="v">' + value + '</div>' + (sub ? '<div class="s">' + sub + '</div>' : '') + '</div>';
  }
  /* Writing consistency: streak / missed days / word-count swings */
  kpiStability(p) {
    const daily = p.data.daily || {};
    const get = (off) => { const d = new Date(); d.setDate(d.getDate() - off); return (daily[dateKey(d)] || {}).words || 0; };
    /* Streak: count from today if today had output, otherwise from yesterday */
    let streak = 0, start = get(0) > 0 ? 0 : (get(1) > 0 ? 1 : -1);
    if (start >= 0) { let i = start; while (get(i) > 0) { streak++; i++; } }
    /* Missed days: zero-word days in the last 30 (counted from the first recorded day) */
    let gaps = 0, recorded = 0;
    for (let i = 0; i < 30; i++) { const w = get(i); if (w > 0) recorded++; else if (daily[dateKeyOf(i)] || (i < 30 && (30 - i) <= firstAge(daily))) gaps++; }
    /* Word-count swings: stddev/mean over the last 14 productive days */
    const ws = []; for (let i = 0; i < 14; i++) { const w = get(i); if (w > 0) ws.push(w); }
    let cv = '—';
    if (ws.length >= 3) {
      const mean = ws.reduce((a, b) => a + b, 0) / ws.length;
      const sd = Math.sqrt(ws.reduce((a, b) => a + (b - mean) * (b - mean), 0) / ws.length);
      cv = Math.round((sd / mean) * 100) + '%';
    }
    return this.kpiRow('Streak', streak + ' days', streak >= 3 ? '🔥 On a roll' : 'Keep it up') +
      this.kpiRow('Missed days (30d)', gaps + ' times', recorded + ' days with output') +
      this.kpiRow('Word-count swings (14d)', cv, ws.length + ' productive days');
    function firstAge(dl) { /* Days since first record: zero words but never recorded doesn't count as missed */
      const keys = Object.keys(dl).sort();
      if (!keys.length) return 99;
      const d0 = new Date(keys[0]); const d1 = new Date();
      return Math.floor((d1 - d0) / 86400e3);
    }
    function dateKeyOf(off) { const d = new Date(); d.setDate(d.getDate() - off); return dateKey(d); }
  }
  /* Efficiency: active writing ratio / delete-edit ratio / stuck time / Pomodoro completion */
  kpiEfficiency(p) {
    let open = 0, active = 0;
    Object.values(p.data.chapters || {}).forEach((m) => { const t = m && m.timing; if (t) { open += t.open || 0; active += t.active || 0; } });
    const effPct = open > 0 ? Math.round((active / open) * 100) : 0;
    let del = 0, wds = 0;
    Object.values(p.data.daily || {}).forEach((d) => { del += d.del || 0; wds += d.words || 0; });
    const delPct = (del + wds) > 0 ? Math.round((del / (del + wds)) * 100) : 0;
    const stuck = Math.max(0, open - active);
    const pm = p.data.pomo || { started: 0, completed: 0 };
    const pomoPct = pm.started > 0 ? Math.round((pm.completed / pm.started) * 100) : 0;
    return this.kpiRow('Active writing time ratio', effPct + '%', fmtDur(active) + ' / ' + fmtDur(open)) +
      this.kpiRow('Delete/edit ratio', delPct + '%', 'Del ' + fmt(del) + ' · wrote ' + fmt(wds)) +
      this.kpiRow('Stuck / idle time', fmtDur(stuck), 'Time open but not writing') +
      this.kpiRow('Pomodoro completion', pomoPct + '%', pm.completed + ' / ' + pm.started + ' sessions');
  }
  /* Goals: daily goal completion / monthly finalization rate / avg time per chapter */
  kpiGoals(p) {
    const goal = Number(p.settings.dailyGoal) || 1000;
    const daily = p.data.daily || {};
    let hit = 0, rec = 0;
    for (let i = 0; i < 30; i++) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const dd = daily[dateKey(d)];
      if (dd && (dd.words > 0 || dd.secs > 0)) { rec++; if ((dd.words || 0) >= goal) hit++; }
    }
    const goalPct = rec > 0 ? Math.round((hit / rec) * 100) : 0;
    /* Monthly finalization rate: share of chapters written this month that are Final */
    const now = new Date(), monthPrefix = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    const chapters = (p.stats && p.stats.chapters) || [];
    const timingMap = p.data.chapters || {};
    let written = 0, done = 0;
    chapters.forEach((c) => {
      const t = (timingMap[c.path] || {}).timing;
      if (t && (t.written > 0 || t.open > 0)) { written++; if (c.status === 3) done++; }
    });
    const finPct = written > 0 ? Math.round((done / written) * 100) : 0;
    /* Avg time per chapter */
    let totOpen = 0, cnt = 0;
    Object.values(timingMap).forEach((m) => { const t = m && m.timing; if (t && t.open > 60) { totOpen += t.open; cnt++; } });
    const avgOpen = cnt > 0 ? Math.round(totOpen / cnt) : 0;
    return this.kpiRow('Daily goal completion', goalPct + '%', 'Met goal on ' + hit + '/' + rec + ' days · goal ' + fmt(goal) + ' words') +
      this.kpiRow('Finalized rate (this book)', finPct + '%', done + ' / ' + written + ' chapters finalized') +
      this.kpiRow('Avg time per chapter', cnt > 0 ? fmtDur(avgOpen) : '—', cnt + ' chapters timed');
  }
  /* Daily word series (last n days, including today) */
  dailySeries(p, n) {
    const arr = [];
    for (let i = n - 1; i >= 0; i--) {
      const dt = new Date(); dt.setDate(dt.getDate() - i);
      const k = dateKey(dt);
      arr.push({ k, w: (p.data.daily[k] || {}).words || 0, label: (dt.getMonth() + 1) + '/' + dt.getDate() });
    }
    return arr;
  }
  entityTop10(p) {
    const st = p.stats || { perEntity: {} };
    const arr = Object.values(st.perEntity || {}).filter((pe) => pe && pe.entity && pe.total > 0);
    if (!arr.length) return '<div class="nws-dc-empty">No lore has appeared in the manuscript yet — write character / worldbuilding names in the body and bar stats will show up here.</div>';
    arr.sort((a, b) => b.total - a.total);
    const top = arr.slice(0, 10);
    /* Same colors as body lore highlighting (nws-c0..5), light/dark variants follow the theme */
    const dark = document.body.classList.contains('theme-dark');
    const COLORS = dark ? ['#E0A19B', '#A6C7AF', '#A4BED6', '#E0B57F', '#DCCB7E', '#BCAED0'] : ['#B5716B', '#6F9A7C', '#6287A8', '#B98448', '#B19A44', '#8E7BA9'];
    const max = top[0].total || 1;
    const rows = top.map((pe, i) => {
      const e = pe.entity;
      const pct = Math.max(6, Math.round((pe.total / max) * 100));
      const color = hasEntityColor(e) ? COLORS[e.color % 6] : 'var(--nws-accent)';
      return '<div class="nws-top-row" data-ent="' + escapeHtml(e.id) + '" title="Click to open lore note">' +
        '<span class="rk">' + (i + 1) + '</span>' +
        '<span class="nm">' + escapeHtml(e.name || '') + (e.type ? ' <i class="tp">' + escapeHtml(e.type) + '</i>' : '') + '</span>' +
        '<span class="bar"><i style="width:' + pct + '%;background:' + color + '"></i></span>' +
        '<span class="ct">' + fmt(pe.total) + ' times</span></div>';
    }).join('');
    return '<div class="nws-top10">' + rows + '</div>';
  }
  /* Content updates: recently changed chapters + lore notes (by file mtime) */
  recentUpdates(p) {
    const items = [];
    const push = (path, name, kind) => {
      try {
        const f = p.app.vault.getAbstractFileByPath(path);
        if (f && f.stat && f.stat.mtime) items.push({ path, name, kind, mtime: f.stat.mtime });
      } catch (e) { /* ignore */ }
    };
    (p.allChapters() || []).slice(0, 60).forEach((c) => push(c.path, c.title, 'Chapter'));
    (p.data.entities || []).forEach((e) => { if (e.file) push(e.file, e.name || String(e.file), e.type || 'Lore'); });
    if (!items.length) return '<div class="nws-dc-empty">No chapters or lore files yet — create chapters in the catalog first.</div>';
    items.sort((a, b) => b.mtime - a.mtime);
    const top = items.slice(0, 10);
    const now = Date.now();
    const rel = (ms) => {
      const dt = Math.floor((now - ms) / 1000);
      if (dt < 60) return 'just now';
      if (dt < 3600) return Math.floor(dt / 60) + ' min ago';
      if (dt < 86400) return Math.floor(dt / 3600) + ' h ago';
      if (dt < 86400 * 30) return Math.floor(dt / 86400) + ' d ago';
      return new Date(ms).toISOString().slice(0, 10);
    };
    const rows = top.map((it) => '<div class="nws-upd-row" data-open="' + escapeHtml(it.path) + '" title="Click to open">' +
      '<span class="k ' + (it.kind === 'Chapter' ? 'ch' : 'ent') + '">' + (it.kind === 'Chapter' ? '📄 Chapters' : '🏷 Lore') + '</span>' +
      '<span class="nm">' + escapeHtml(it.name) + '</span>' +
      '<span class="tm">' + rel(it.mtime) + '</span></div>').join('');
    return '<div class="nws-updates">' + rows + '</div>';
  }
  heatmap(p, days) {
    const small = days > 100;
    const cells = [];
    const end = new Date(); end.setHours(0, 0, 0, 0);
    const start = new Date(end); start.setDate(start.getDate() - (days - 1));
    /* Align to the start of Sunday */
    const gridStart = new Date(start); gridStart.setDate(gridStart.getDate() - gridStart.getDay());
    let cur = new Date(gridStart);
    const weeks = [];
    let monthMarks = '';
    let lastMonth = -1;
    while (cur <= end) {
      if (small && cur.getDay() === 0 && cur.getMonth() !== lastMonth) { lastMonth = cur.getMonth(); monthMarks += '<span style="width:' + (weeks.length * 10) + 'px" class="mk">' + (lastMonth + 1) + 'mo</span>'; }
      const week = [];
      for (let d = 0; d < 7; d++) {
        const k = dateKey(cur);
        const w = (p.data.daily[k] || {}).words || 0;
        let lv = 0;
        if (w > 0 && w < 500) lv = 1; else if (w < 1500) lv = 2; else if (w < 3000) lv = 3; else if (w >= 3000) lv = 4;
        const inRange = cur >= start && cur <= end;
        week.push('<i class="nws-heat h' + lv + (inRange ? '' : ' out') + '" title="' + k + ': ' + fmt(w) + ' words"></i>');
        cur.setDate(cur.getDate() + 1);
      }
      weeks.push('<div class="nws-heat-week">' + week.join('') + '</div>');
    }
    const cls = small ? ' nws-heatmap sm' : '';
    return (small && monthMarks ? '<div class="nws-heat-months">' + monthMarks + '</div>' : '') +
      '<div class="nws-heatmap' + cls + '">' + weeks.join('') + '</div>';
  }
}

/* ================= v2.5 chapter stats modal =================
   Per chapter: goal vs words / writing pace / focus time / idle time /
   lore stats by category and library / top 10 lore in this chapter. */
class ChapterStatsModal extends Modal {
  constructor(app, plugin, path) { super(app); this.p = plugin; this.path = path; }
  onOpen() {
    this.contentEl.addClass('nws-chstat-modal');
    this.render();
    /* Light refresh every 3s while focus/writing is running */
    this._timer = setInterval(() => { if (this.p.focusState.active) this.render(); }, 3000);
  }
  render() {
    const p = this.p, path = this.path;
    const ch = (p.allChapters().find((c) => c.path === path)) || { title: path.split('/').pop().replace(/\.md$/, ''), volume: '—', words: 0, status: 0 };
    const t = p.chapterTiming(path);
    const target = p.targetOf(path);
    const words = ch.words || 0;
    const idle = Math.max(0, t.open - t.active);
    const speed = t.active > 0 ? Math.round(t.written / (t.active / 60)) : 0;
    const pct = target > 0 ? Math.min(100, Math.round(words / target * 100)) : 0;
    const st = p.aggregate();
    const es = p.chapterEntityStats(path);

    const bar = (pctv) => '<div class="nws-chprog"><div class="fill" style="width:' + Math.max(0, Math.min(100, pctv)) + '%"></div></div>';
    const row = (k, v) => '<div class="nws-chrow"><span class="k">' + k + '</span><span class="v">' + v + '</span></div>';
    const gbar = (val, max) => '<span class="nws-chgbar"><i style="width:' + (max > 0 ? Math.round(val / max * 100) : 0) + '%"></i></span>';

    /* Category stats */
    const gmax = es.groups.length ? Math.max.apply(null, es.groups.map((g) => g.total)) : 0;
    const gRows = es.groups.map((g) => {
      const sub = g.libArr.map((l) => typeEmoji(l.name) + ' ' + escapeHtml(l.name) + '×' + l.total).join('　');
      return row(groupEmoji(g.name) + ' ' + escapeHtml(g.name), '<b>' + g.total + '</b> times ' + gbar(g.total, gmax) + (sub ? '<span class="sub">' + sub + '</span>' : ''));
    }).join('');
    /* Library stats */
    const lmax = es.libs.length ? Math.max.apply(null, es.libs.map((l) => l.total)) : 0;
    const lRows = es.libs.map((l) => row(l.emoji + ' ' + escapeHtml(l.name), '<b>' + l.total + '</b> times ' + gbar(l.total, lmax))).join('');
    /* Top10 */
    const topRows = es.top.map((it, i) =>
      '<div class="nws-chtop" data-eid="' + it.e.id + '"><span class="rk">' + (i + 1) + '</span>' +
      '<span class="nm">' + typeEmoji(it.e.type) + ' ' + escapeHtml(it.e.name) + '</span>' +
      '<span class="nws-chgbar"><i style="width:' + (es.top[0].n ? Math.round(it.n / es.top[0].n * 100) : 0) + '%"></i></span>' +
      '<b class="ct">×' + it.n + '</b></div>').join('');

    const html =
      '<h3>📊 Chapter Stats — ' + escapeHtml(ch.title) + '</h3>' +
      '<div class="nws-chmeta">' + escapeHtml(ch.volume) + ' · ' + (CH_STATUS[ch.status] || 'Draft') +
      (es.total ? ' · lore appeared in this chapter <b>' + es.total + '</b> times' : '') + '</div>' +

      '<div class="nws-chsec"><h4>🎯 Goal & Words</h4>' +
      row('Current words', '<b>' + fmt(words) + '</b> words') +
      row('Chapter goal', target > 0 ? fmt(target) + ' words' : 'Not set (global default ' + fmt(p.settings.chapterTarget || DEFAULT_CHAPTER_TARGET) + ' words)') +
      (target > 0 ? row('Completion', pct + '% (' + fmt(Math.max(0, target - words)) + ' words)' + bar(pct)) : '') +
      '</div>' +

      '<div class="nws-chsec"><h4>⏱️ Writing & Focus</h4>' +
      '<div class="nws-dc-cards">' +
      [['Writing pace', t.active > 0 ? speed + ' wpm' : '—', '⚡'],
       ['Writing time', fmtDur(t.active), '⌨️'],
       ['Focus time', fmtDur(t.focus), '🎯'],
       ['Idle time', fmtDur(idle), '😴']].map((kv) =>
        '<div class="nws-dc-card"><div class="k">' + kv[2] + ' ' + kv[0] + '</div><div class="v">' + kv[1] + '</div></div>').join('') +
      '</div>' +
      row('Time on this chapter', fmtDur(t.open)) + row('Total typed this chapter', fmt(t.written) + ' words (incl. deletions / edits)') +
      '<div class="nws-chtip">Timing starts when the chapter opens; keystrokes within 60s count as writing, otherwise idle; focus-mode time counts as focus automatically.</div></div>' +

      '<div class="nws-chsec"><h4>🗂️ Lore by Category (lore in this chapter)</h4>' +
      (es.groups.length
        ? '<div class="nws-chlist">' + gRows + '</div>' +
          '<details class="nws-chlibs"><summary>By library (' + es.libs.length + ' libraries)</summary><div class="nws-chlist">' + lRows + '</div></details>'
        : '<div class="nws-chtip">No lore words in this chapter yet. With lore highlighting on, lore appearing in the body is tracked automatically.</div>') +
      '</div>' +

      '<div class="nws-chsec"><h4>🏆 Top lore in this chapter ' + Math.min(10, es.top.length || 10) + '</h4>' +
      (es.top.length ? '<div class="nws-chtops">' + topRows + '</div>' : '<div class="nws-chtip">No data yet.</div>') +
      '</div>';

    this.contentEl.innerHTML = html;
    this.modalEl.classList.toggle('nws-wide', false);
    /* Top 10 click → open lore details */
    this.contentEl.querySelectorAll('.nws-chtop').forEach((r) => r.addEventListener('click', () => {
      const e = p.entityById(r.dataset.eid);
      if (e) { this.close(); new EntityDetailModal(this.app, p, e).open(); }
    }));
  }
  onClose() { if (this._timer) clearInterval(this._timer); this.contentEl.empty(); }
}

/* Move a chapter to another volume */
class ChapterMoveModal extends Modal {
  constructor(app, plugin, path) { super(app); this.p = plugin; this.path = path; }
  onOpen() {
    const { contentEl } = this, p = this.p;
    const title = this.path.split('/').pop().replace(/\.md$/, '');
    const cur = p.volumeOfPath(this.path);
    /* Collect all volumes (keep catalog order: unfiled first) */
    const bodyRoot = p.settings.folderBody || 'Manuscript';
    const vols = [];
    p.app.vault.getMarkdownFiles().forEach((f) => {
      if (f.path.indexOf(bodyRoot + '/') !== 0) return;
      const rel = f.path.slice((bodyRoot + '/').length);
      const i = rel.indexOf('/');
      if (i > 0 && vols.indexOf(rel.slice(0, i)) < 0) vols.push(rel.slice(0, i));
    });
    contentEl.createEl('h3', { text: '📁 Move chapter "' + title + '"' });
    const desc = contentEl.createEl('div', { text: 'Current volume: ' + cur + '. Click a target volume to move it (the chapter file moves with its status / goal / timer data).' });
    desc.style.cssText = 'font-size:11px;color:var(--text-muted);margin-bottom:10px;line-height:1.6';
    const row = contentEl.createDiv(); row.style.cssText = 'display:flex;flex-direction:column;gap:6px';
    const targets = ['(Unfiled)'].concat(vols.filter((v) => v !== cur));
    if (!targets.length) { const t = contentEl.createEl('div', { text: 'No other volumes to move to. Create one in the catalog with "＋ New Volume" first.' }); t.style.cssText = 'color:var(--text-muted);font-size:12px'; return; }
    targets.forEach((v) => {
      const b = row.createEl('button', { text: (v === '(Unfiled)' ? '📂 ' + v + '(manuscript root)' : '📚 ' + v) });
      b.className = 'nws-btn';
      b.style.cssText = 'text-align:left;width:100%';
      b.addEventListener('click', async () => { this.close(); await p.moveChapter(this.path, v); });
    });
  }
  onClose() { this.contentEl.empty(); }
}

/* v2.7 volume analytics: aggregated stats for all chapters in one volume */
class VolumeStatsModal extends Modal {
  constructor(app, plugin, volume) { super(app); this.p = plugin; this.volume = volume; }
  onOpen() {
    const { contentEl } = this, p = this.p;
    const vols = Object.create(null);
    p.allChapters().forEach((c) => { (vols[c.volume] = vols[c.volume] || []).push(c); });
    const list = vols[this.volume] || [];
    const words = list.reduce((s, c) => s + c.words, 0);
    const target = list.reduce((s, c) => s + p.targetOf(c.path), 0);
    /* Lore aggregation within the volume */
    const agg = Object.create(null);
    list.forEach((c) => { const m = p.stats.perChapter[c.path] || {}; Object.keys(m).forEach((id) => { agg[id] = (agg[id] || 0) + m[id]; }); });
    const top = Object.keys(agg).sort((a, b) => agg[b] - agg[a]).slice(0, 10);
    /* Timing aggregation */
    const tim = list.reduce((acc, c) => { const t = p.chapterTiming(c.path); acc.open += t.open; acc.active += t.active; acc.focus += t.focus; acc.written += t.written; return acc; }, { open: 0, active: 0, focus: 0, written: 0 });
    const stCount = list.map((c) => (c.status == null ? (c.words > 0 ? 1 : 0) : c.status));
    const stRows = CH_STATUS.map((s, i) => '<span class="nws-tag">' + s + ' × ' + stCount.filter((x) => x === i).length + '</span>').join(' ');
    const pct = target > 0 ? Math.min(100, Math.round(words / target * 100)) : 0;

    contentEl.createEl('h3', { text: '📊 Volume Analytics · ' + this.volume });
    const cards = contentEl.createDiv();
    cards.style.cssText = 'display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:10px';
    [['Chapters', list.length], ['Total words', fmt(words)], ['Total goal', target > 0 ? fmt(target) : 'Not set'], ['Completion', pct + '%']].forEach((kv) => {
      const d = cards.createDiv(); d.style.cssText = 'background:var(--background-secondary);border-radius:8px;padding:8px;text-align:center';
      const k = d.createDiv(); k.textContent = kv[0]; k.style.cssText = 'font-size:10px;color:var(--text-muted)';
      const v = d.createDiv(); v.textContent = String(kv[1]); v.style.cssText = 'font-size:16px;font-weight:700';
    });
    const prog = contentEl.createDiv();
    prog.style.cssText = 'height:8px;background:var(--background-secondary);border-radius:4px;overflow:hidden;margin-bottom:10px';
    prog.innerHTML = '<div style="height:100%;width:' + pct + '%;background:linear-gradient(90deg,#a8bfa0,#c9a24a)"></div>';
    const stRow = contentEl.createDiv(); stRow.style.cssText = 'margin-bottom:10px;display:flex;gap:6px;flex-wrap:wrap';
    stRow.innerHTML = stRows;
    /* Per-chapter table */
    const tbl = contentEl.createEl('table');
    tbl.style.cssText = 'width:100%;font-size:12px;border-collapse:collapse;margin-bottom:12px';
    tbl.innerHTML = '<thead><tr>' + ['Chapter', 'Status', 'Words / Goal', 'Open', 'Writing', 'Idle', 'Focus'].map((h) => '<th style="text-align:left;padding:4px 6px;border-bottom:1px solid var(--background-modifier-border)">' + h + '</th>').join('') + '</tr></thead><tbody>' +
      list.map((c) => {
        const t = p.chapterTiming(c.path);
        const st = CH_STATUS[c.status == null ? (c.words > 0 ? 1 : 0) : c.status];
        return '<tr>' + ['<td>' + escapeHtml(c.title) + '</td>', '<td>' + st + '</td>', '<td>' + fmt(c.words) + ' / ' + (p.targetOf(c.path) || '—') + '</td>', '<td>' + fmtDur(t.open) + '</td>', '<td>' + fmtDur(t.active) + '</td>', '<td>' + fmtDur(t.open - t.active) + '</td>', '<td>' + fmtDur(t.focus) + '</td>'].join('') + '</tr>';
      }).join('') + '</tbody>';
    /* Top 10 lore in the volume */
    contentEl.createEl('p', { text: 'Top 10 lore in this volume' }).style.cssText = 'font-weight:600;margin-bottom:5px';
    if (top.length) {
      const max = agg[top[0]];
      const box = contentEl.createDiv();
      top.forEach((id) => {
        const e = p.entityById(id);
        if (!e) return;
        const rowEl = box.createDiv(); rowEl.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:4px';
        const nm = rowEl.createSpan(); nm.textContent = typeEmoji(e.type) + ' ' + e.name; nm.style.cssText = 'width:130px;font-size:12px;flex-shrink:0';
        const bar = rowEl.createDiv(); bar.style.cssText = 'flex:1;height:10px;background:var(--background-secondary);border-radius:5px;overflow:hidden';
        bar.innerHTML = '<div style="height:100%;width:' + Math.round(agg[id] / max * 100) + '%;background:var(--interactive-accent)"></div>';
        const cnt = rowEl.createSpan(); cnt.textContent = '×' + agg[id]; cnt.style.cssText = 'font-size:11px;color:var(--text-muted);width:34px;text-align:right';
      });
    } else {
      const tip = contentEl.createDiv(); tip.textContent = 'No lore words in this volume\'s chapters yet (write lore names into the body and they get tracked).';
      tip.style.cssText = 'color:var(--text-muted);font-size:12px';
    }
    const foot = contentEl.createDiv(); foot.style.cssText = 'margin-top:8px;font-size:10px;color:var(--text-muted)';
    foot.textContent = 'Timers total: open ' + fmtDur(tim.open) + ' · writing ' + fmtDur(tim.active) + ' · idle ' + fmtDur(tim.open - tim.active) + ' · focus ' + fmtDur(tim.focus);
  }
  onClose() { this.contentEl.empty(); }
}

/* v2.7 annotation modal: original untouched, only the annotation is recorded */
class AnnotationModal extends Modal {
  constructor(app, plugin, path, quote, from, to) { super(app); this.p = plugin; this.path = path; this.quote = quote; this.from = from; this.to = to; }
  onOpen() {
    const { contentEl } = this, p = this.p;
    contentEl.createEl('h3', { text: '📝 Add annotation' });
    const q = contentEl.createDiv();
    q.style.cssText = 'font-size:11px;color:var(--text-muted);background:var(--background-secondary);padding:7px 9px;border-radius:7px;line-height:1.6;margin-bottom:10px';
    q.textContent = 'Annotation on: "' + this.quote.slice(0, 80) + (this.quote.length > 80 ? '…' : '') + '"';
    contentEl.createEl('p', { text: 'Annotation content (the original text is never modified; hover over that passage to see the annotation)' }).style.cssText = 'font-weight:600;margin-bottom:5px';
    const ta = contentEl.createEl('textarea');
    ta.placeholder = 'Write your thoughts: why this passage reads this way, what to change, idea extensions…';
    ta.style.cssText = 'width:100%;height:110px;font-size:13px';
    const row = contentEl.createDiv(); row.style.cssText = 'margin-top:10px;text-align:right';
    const cancel = row.createEl('button', { text: 'Cancel' }); cancel.style.marginRight = '8px';
    const ok = row.createEl('button', { text: 'Save annotation' }); ok.className = 'mod-cta';
    cancel.addEventListener('click', () => this.close());
    ok.addEventListener('click', async () => {
      await p.addAnnotation(this.path, this.quote, ta.value.trim(), this.from, this.to);
      this.close();
    });
    setTimeout(() => ta.focus(), 30);
  }
  onClose() { this.contentEl.empty(); }
}

/* v2.7 annotation manager view: table layout, can jump back to the original text */
class AnnotsView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; }
  getViewType() { return VIEW_ANNOT; }
  getDisplayText() { return 'Studio · Annotations'; }
  getIcon() { return 'sticky-note'; }
  async onOpen() { this.render(); }
  render() {
    const p = this.plugin;
    const anns = (p.data.annotations || []).slice().sort((a, b) => b.created - a.created);
    const chTitle = (path) => (p.allChapters().find((c) => c.path === path) || {}).title || String(path).split('/').pop().replace(/\.md$/, '');
    const rows = anns.map((a) =>
      '<tr data-aid="' + a.id + '">' +
      '<td class="c">' + escapeHtml(chTitle(a.path)) + '</td>' +
      '<td class="q">“' + escapeHtml(String(a.quote || '').slice(0, 40)) + (String(a.quote || '').length > 40 ? '…' : '') + '”</td>' +
      '<td class="n">' + escapeHtml(a.note || '(empty)') + '</td>' +
      '<td class="t">' + new Date(a.created).toLocaleDateString() + '</td>' +
      '<td class="ops"><button class="nws-btn sm" data-jump="' + a.id + '">Jump</button><button class="nws-btn sm" data-edit="' + a.id + '">Edit</button><button class="nws-btn sm" data-del="' + a.id + '">Del</button></td>' +
      '</tr>').join('');
    const root = setViewRoot(this,
      '<div class="nws-phead"><div class="nws-row"><div class="nws-ptitle">📝 Annotations <span class="nws-tag">' + anns.length + ' items</span></div>' +
      '<div class="nws-sp"></div><button class="nws-fold" data-view="catalog">📖 Catalog</button></div>' +
      '<div class="nws-psub">Select text in the body → right-click → "📝 Add annotation" · the original text is never touched; hover over the passage to see the annotation</div></div>' +
      (anns.length
        ? '<table class="nws-annot-table"><thead><tr><th>Chapter</th><th>Original Excerpt</th><th>Annotation</th><th>Date</th><th>Actions</th></tr></thead><tbody>' + rows + '</tbody></table>'
        : '<div class="nws-empty">No annotations yet.<br>Select a passage in the body, right-click and pick "📝 Add annotation".</div>'));
    root.querySelector('[data-view="catalog"]').addEventListener('click', () => p.activateView(VIEW_CATALOG));
    root.querySelectorAll('[data-jump]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const a = p.annotById(b.dataset.jump);
      if (a) p.jumpToAnnotation(a);
    }));
    root.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const a = p.annotById(b.dataset.edit);
      if (a) new AnnotationEditModal(this.app, p, a).open();
    }));
    root.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm('Delete this annotation?')) p.deleteAnnotation(b.dataset.del);
    }));
    root.querySelectorAll('tr[data-aid]').forEach((tr) => tr.addEventListener('click', () => {
      const a = p.annotById(tr.dataset.aid);
      if (a) p.jumpToAnnotation(a);
    }));
  }
}

/* Edit an existing annotation */
class AnnotationEditModal extends Modal {
  constructor(app, plugin, annot) { super(app); this.p = plugin; this.a = annot; }
  onOpen() {
    const { contentEl } = this, p = this.p;
    contentEl.createEl('h3', { text: '📝 Edit annotation' });
    const q = contentEl.createDiv();
    q.style.cssText = 'font-size:11px;color:var(--text-muted);background:var(--background-secondary);padding:7px 9px;border-radius:7px;line-height:1.6;margin-bottom:10px';
    q.textContent = 'Annotation on: "' + String(this.a.quote || '').slice(0, 80) + '"';
    const ta = contentEl.createEl('textarea');
    ta.value = this.a.note || '';
    ta.style.cssText = 'width:100%;height:110px;font-size:13px';
    const row = contentEl.createDiv(); row.style.cssText = 'margin-top:10px;text-align:right';
    const ok = row.createEl('button', { text: 'Save' }); ok.className = 'mod-cta';
    ok.addEventListener('click', async () => { await p.updateAnnotation(this.a.id, { note: ta.value.trim() }); this.close(); });
    setTimeout(() => ta.focus(), 30);
  }
  onClose() { this.contentEl.empty(); }
}

/* ================= v2.1 Pomodoro / Focus Mode ================= */
class FocusModal extends Modal {
  constructor(app, plugin, mode) { super(app); this.p = plugin; this.mode = mode || 'focus'; }
  onOpen() {
    const { contentEl } = this, p = this.p;
    contentEl.empty();
    contentEl.createEl('h3', { text: this.mode === 'pomodoro' ? '🍅 Pomodoro' : '🎯 Focus Mode' });
    const desc = contentEl.createDiv();
    desc.style.cssText = 'font-size:11px;color:var(--text-muted);line-height:1.6;margin-bottom:10px';
    desc.textContent = this.mode === 'pomodoro'
      ? 'Focus ' + p.settings.pomodoroWork + ' min / short break ' + p.settings.pomodoroBreak + ' min / ' + p.settings.pomodoroRounds + ' rounds then long break ' + p.settings.pomodoroLongBreak + ' min; type any number of minutes below.'
      : 'Enter fullscreen zen mode: low-stimulus dark wallpaper + optional ambient sound + typing sounds; the current paragraph is highlighted, others fade.';

    /* --- Duration selection --- */
    const row = contentEl.createDiv(); row.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:6px';
    row.createSpan({ text: 'Duration: ' }).style.cssText = 'font-size:11px';
    let chosenSec = 0;
    const presets = this.mode === 'pomodoro'
      ? [{ l: 'Focus ' + p.settings.pomodoroWork + 'm', s: p.settings.pomodoroWork * 60 }, { l: 'Short break ' + p.settings.pomodoroBreak + 'm', s: p.settings.pomodoroBreak * 60 }, { l: 'Long break ' + p.settings.pomodoroLongBreak + 'm', s: p.settings.pomodoroLongBreak * 60 }]
      : [{ l: '15 min', s: 900 }, { l: '25 min', s: 1500 }, { l: '45 min', s: 2700 }, { l: '90 min', s: 5400 }];
    let activeBtn = null;
    presets.forEach((ps, i) => {
      const b = row.createEl('button', { text: ps.l }); b.className = 'nws-fbtn' + (i === (this.mode === 'pomodoro' ? 0 : 0) ? ' on' : '');
      if (i === 0) { activeBtn = b; chosenSec = ps.s; }
      b.addEventListener('click', () => { if (activeBtn) activeBtn.removeClass('on'); b.addClass('on'); activeBtn = b; chosenSec = ps.s; });
    });
    /* v2.8: type any minute count (1-600); it's remembered as the default afterwards */
    const crow = contentEl.createDiv(); crow.style.cssText = 'display:flex;gap:6px;align-items:center;margin:4px 0 6px';
    crow.createSpan({ text: 'Custom minutes: ' }).style.cssText = 'font-size:11px';
    const minInput = crow.createEl('input'); minInput.type = 'number'; minInput.min = '1'; minInput.max = '600';
    minInput.value = String(this.mode === 'pomodoro' ? (p.settings.pomodoroWork || 25) : (p.settings.focusMinutes || 25));
    minInput.style.cssText = 'width:64px;font-size:12px;padding:3px 6px';
    const applyBtn = crow.createEl('button', { text: 'Apply' }); applyBtn.className = 'nws-fbtn';
    const applyMinutes = () => {
      const n = clamp(parseInt(minInput.value, 10) || 0, 1, 600);
      if (!n) { new Notice('Enter minutes between 1 and 600'); return; }
      minInput.value = String(n);
      chosenSec = n * 60;
      if (activeBtn) activeBtn.removeClass('on');
      if (this.mode === 'pomodoro') { p.settings.pomodoroWork = n; } else { p.settings.focusMinutes = n; }
      p.saveNow();
      new Notice('Set to ' + n + ' minutes');
    };
    applyBtn.addEventListener('click', applyMinutes);
    minInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyMinutes(); });

    if (this.mode === 'focus') {
      /* Fullscreen zen mode toggle */
      const frow = contentEl.createDiv(); frow.style.cssText = 'margin-top:10px;display:flex;align-items:center;gap:8px';
      const fcb = frow.createEl('input'); fcb.type = 'checkbox'; fcb.checked = p.settings.focusFullscreen !== false;
      frow.createSpan({ text: 'Auto fullscreen on focus (hides both sidebars, restores on exit)' }).style.cssText = 'font-size:11px';
      fcb.addEventListener('change', async () => { p.settings.focusFullscreen = fcb.checked; await p.saveNow(); });
      /* Wallpaper selection (including the new low-stimulus dark set) */
      contentEl.createEl('div', { text: 'Focus wallpaper' }).style.cssText = 'font-size:11px;font-weight:600;margin:12px 0 5px';
      const wrow = contentEl.createDiv(); wrow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap';
      let aw = null;
      FOCUS_WALLPAPERS.forEach((w) => {
        const b = wrow.createEl('button', { text: w.name }); b.className = 'nws-fbtn' + (w.id === p.settings.focusWallpaper ? ' on' : '');
        if (w.id === p.settings.focusWallpaper) aw = b;
        b.addEventListener('click', () => { if (aw) aw.removeClass('on'); b.addClass('on'); aw = b; p.settings.focusWallpaper = w.id; p.saveNow(); });
      });
      /* Typing sound: one beep per keypress (independent of ambient sound) */
      contentEl.createEl('div', { text: 'Typing sound (one beep per keypress)' }).style.cssText = 'font-size:11px;font-weight:600;margin:12px 0 5px';
      const trow2 = contentEl.createDiv(); trow2.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap';
      let at = null;
      TYPING_SOUNDS.forEach((s) => {
        const b = trow2.createEl('button', { text: s.name }); b.className = 'nws-fbtn' + ((s.id === p.settings.typeSound) || (s.id === 'key' && !p.settings.typeSound) ? ' on' : '');
        if (b.hasClass('on')) at = b;
        b.addEventListener('click', () => { if (at) at.removeClass('on'); b.addClass('on'); at = b; p.settings.typeSound = s.id; p.saveNow(); if (s.id !== 'off') p.playTypeSound(true); });
      });
      /* Ambient sound: looping environment audio, optional off */
      contentEl.createEl('div', { text: 'Ambient sound (looping environment audio, can be off)' }).style.cssText = 'font-size:11px;font-weight:600;margin:12px 0 5px';
      const srow = contentEl.createDiv(); srow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap';
      let as = null;
      FOCUS_SOUNDS.forEach((s) => {
        const b = srow.createEl('button', { text: s.name }); b.className = 'nws-fbtn' + (s.id === p.settings.focusSound ? ' on' : '');
        if (s.id === p.settings.focusSound) as = b;
        b.addEventListener('click', () => {
          if (as) as.removeClass('on'); b.addClass('on'); as = b;
          p.settings.focusSound = s.id; p.saveNow();
          p.startSound(s.id); // preview
        });
      });
      /* Typing mode toggle */
      const trow = contentEl.createDiv(); trow.style.cssText = 'margin-top:12px;display:flex;align-items:center;gap:8px';
      const tcb = trow.createEl('input'); tcb.type = 'checkbox'; tcb.checked = !!p.settings.typingMode;
      trow.createSpan({ text: 'Typing mode (current paragraph highlighted, others fade out)' }).style.cssText = 'font-size:11px';
      tcb.addEventListener('change', async () => { p.settings.typingMode = tcb.checked; p.entityVersion++; await p.saveNow(); });
    }

    /* Live display */
    const live = contentEl.createDiv('nws-focus-live');
    live.style.cssText = 'margin-top:14px;padding:12px;border:1px solid var(--nws-line);border-radius:8px;text-align:center;background:var(--background-secondary)';
    const renderLive = () => {
      const s = p.focusState;
      if (!s.active) { live.innerHTML = '<div style="font-size:11px;color:var(--text-muted)">Not started · live pace and remaining words will show here</div>'; return; }
      const left = Math.max(0, (s.left || 0));
      const f = p.app.workspace.getActiveFile();
      const target = f ? p.targetOf(f.path) : 0;
      const words = f ? (p.wordCache[f.path] || 0) : 0;
      const remainWord = target > 0 ? Math.max(0, target - words) : 0;
      live.innerHTML = '<div style="font-size:26px;font-weight:600;font-variant-numeric:tabular-nums">' + fmtDur(left) + '</div>' +
        '<div style="font-size:11px;color:var(--text-muted);margin-top:4px">' +
        (s.paused ? '⏸ Paused' : '● Running') + ' · ⚡ ' + p.pacePerMinute() + ' wpm' +
        (target > 0 ? ' · chapter needs ' + fmt(remainWord) + ' words' : '') + '</div>';
    };
    renderLive();
    this._liveTimer = setInterval(() => renderLive(), 1000);

    /* Buttons */
    const brow = contentEl.createDiv(); brow.style.cssText = 'margin-top:14px;text-align:right;display:flex;gap:8px;justify-content:flex-end';
    const startBtn = brow.createEl('button', { text: '▶ Start' }); startBtn.className = 'mod-cta';
    startBtn.addEventListener('click', () => {
      if (p.focusState.active) { new Notice('A timer is already running — end it first'); return; }
      p.startFocusSession(this.mode === 'pomodoro' ? 'work' : 'focus', chosenSec || 1500);
      renderLive();
    });
    const pauseBtn = brow.createEl('button', { text: '⏸ Pause / Resume' });
    pauseBtn.addEventListener('click', () => { if (p.focusState.active) { p.pauseFocusSession(); renderLive(); } });
    const stopBtn = brow.createEl('button', { text: '■ End' });
    stopBtn.addEventListener('click', () => { if (p.focusState.active) { p.stopFocusSession(); renderLive(); } });
  }
  onClose() {
    if (this._liveTimer) clearInterval(this._liveTimer);
    /* When focus isn't running, closing the modal must stop the preview sound and wallpaper */
    if (!this.p.focusState.active) { this.p.stopSound(); this.p.clearFocusWallpaper(); }
    this.contentEl.empty();
  }
}

/* ================= Settings page ================= */
class NSSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.p = plugin; }
  display() {
    const { containerEl } = this;
    const p = this.p;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Novel Writing · Settings' });

    new Setting(containerEl).setName('Manuscript folder').setDesc('Only Markdown files under this folder count as chapters and stats scope')
      .addText((t) => t.setValue(p.settings.folderBody).onChange(async (v) => { p.settings.folderBody = v; await p.saveNow(); await p.rescan(true); }));
    new Setting(containerEl).setName('Outline folder').addText((t) => t.setValue(p.settings.folderOutline).onChange(async (v) => { p.settings.folderOutline = v; await p.saveNow(); }));
    new Setting(containerEl).setName('Lore folder').addText((t) => t.setValue(p.settings.folderSetting).onChange(async (v) => { p.settings.folderSetting = v; await p.saveNow(); }));
    new Setting(containerEl).setName('Ideas folder').setDesc('Each idea is stored as its own md note in this folder (the old single Ideas.md is deprecated)')
      .addText((t) => t.setValue(p.settings.folderInspiration || 'Idea').onChange(async (v) => { p.settings.folderInspiration = v || 'Idea'; await p.saveNow(); }));

    containerEl.createEl('h3', { text: 'Writing aids' });
    new Setting(containerEl).setName('Dialogue highlight').setDesc('Highlight text inside curly quotes “…”')
      .addToggle((t) => t.setValue(p.settings.dialogueHighlight).onChange(async (v) => { p.settings.dialogueHighlight = v; p.entityVersion++; await p.saveNow(); }));
    new Setting(containerEl).setName('Also match straight quotes "…"').addToggle((t) => t.setValue(p.settings.dialogueEnglish).onChange(async (v) => { p.settings.dialogueEnglish = v; p.entityVersion++; await p.saveNow(); }));
    new Setting(containerEl).setName('Lore mention coloring').setDesc('When a lore name / alias appears in the body: with color → bold italic in that color; without → bold italic + underline; hover to preview, click to open the lore note')
      .addToggle((t) => t.setValue(p.settings.entityHighlight).onChange(async (v) => { p.settings.entityHighlight = v; p.entityVersion++; await p.saveNow(); }));
    new Setting(containerEl).setName('Exact-name matching').addToggle((t) => t.setValue(p.settings.entityNameMatch).onChange(async (v) => { p.settings.entityNameMatch = v; p.entityVersion++; await p.saveNow(); }));
    new Setting(containerEl).setName('Alias matching').addToggle((t) => t.setValue(p.settings.entityAliasMatch).onChange(async (v) => { p.settings.entityAliasMatch = v; p.entityVersion++; await p.saveNow(); }));
    new Setting(containerEl).setName('Show type icon before name').addToggle((t) => t.setValue(p.settings.entityEmoji).onChange(async (v) => { p.settings.entityEmoji = v; p.entityVersion++; await p.saveNow(); }));
    new Setting(containerEl).setName('Daily goal (words)').setDesc('Used by "Daily goal completion" in the data center; default 1000 words')
      .addText((t) => t.setValue(String(p.settings.dailyGoal || 1000)).onChange(async (v) => { const n = parseInt(v, 10); p.settings.dailyGoal = (n >= 100 && n <= 100000) ? n : 1000; await p.saveNow(); }));
    new Setting(containerEl).setName('Single-click lore word opens lore note').setDesc('When on, single-clicking a highlighted lore name / alias in the body jumps to its md note (drag-select won\'t misfire); when off, only Ctrl/Cmd+click works')
      .addToggle((t) => t.setValue(p.settings.entityClickJump !== false).onChange(async (v) => { p.settings.entityClickJump = v; await p.saveNow(); }));
    new Setting(containerEl).setName('Hover card delay (ms)').addText((t) => t.setValue(String(p.settings.hoverDelay)).onChange(async (v) => { p.settings.hoverDelay = Number(v) || 0; await p.saveNow(); }));
    new Setting(containerEl).setName('[ ] auto-collect').setDesc('Off by default. Recommended: select text → right-click → "Save as idea". When on, closing a ] saves the content as an idea note and removes it from the body')
      .addToggle((t) => t.setValue(p.settings.autoCollectBracket).onChange(async (v) => { p.settings.autoCollectBracket = v; await p.saveNow(); }));
    new Setting(containerEl).setName('[ ] chip hint').addToggle((t) => t.setValue(p.settings.noteChip).onChange(async (v) => { p.settings.noteChip = v; p.entityVersion++; await p.saveNow(); }));
    new Setting(containerEl).setName('Annotation shading').setDesc('After right-click "Add annotation" on a selection, that passage gets a light yellow shade; hover to read the annotation (the original text is never modified)')
      .addToggle((t) => t.setValue(p.settings.annotShow !== false).onChange(async (v) => { p.settings.annotShow = v; p.entityVersion++; await p.saveNow(); }));
    new Setting(containerEl).setName('Word milestones').setDesc('Every N words, a 🎯 300 / 600 / 900… marker is added at the line\'s right edge')
      .addToggle((t) => t.setValue(p.settings.milestoneMark !== false).onChange(async (v) => { p.settings.milestoneMark = v; p.entityVersion++; await p.saveNow(); }));
    new Setting(containerEl).setName('Milestone step (words)').setDesc('Default 300; at each multiple of 300 a marker is added at the line\'s right edge')
      .addText((t) => t.setValue(String(p.settings.milestoneStep || 300)).onChange(async (v) => { const n = parseInt(v, 10); p.settings.milestoneStep = (n >= 100) ? n : 300; p.entityVersion++; await p.saveNow(); }));

    /* ===== v2.14 body typography ===== */
    containerEl.createEl('h3', { text: 'Body typography' });
    new Setting(containerEl).setName('Enable typography settings').setDesc('Applies to editing, reading view and focus mode at once; headings / lists / quotes / code blocks are excluded automatically, Markdown structure untouched')
      .addToggle((t) => t.setValue(p.settings.typoEnabled !== false).onChange(async (v) => { p.settings.typoEnabled = v; p.applyTypo(); await p.saveNow(); }));
    new Setting(containerEl).setName('Line height').setDesc('Body line-height multiplier, default 1.9; for novels 1.8~2.2 reads well')
      .addSlider((t) => t.setLimits(1, 3, 0.05).setValue(clamp(Number(p.settings.typoLineHeight) || 1.9, 1, 3)).setDynamicTooltip().onChange(async (v) => { p.settings.typoLineHeight = v; p.applyTypo(); p.scheduleSave(); }));
    new Setting(containerEl).setName('Letter spacing').setDesc('Extra distance between characters (em), 0 = default; try 0.05~0.1 for an airier feel')
      .addSlider((t) => t.setLimits(0, 0.3, 0.01).setValue(clamp(Number(p.settings.typoLetterSpacing) || 0, 0, 0.3)).setDynamicTooltip().onChange(async (v) => { p.settings.typoLetterSpacing = v; p.applyTypo(); p.scheduleSave(); }));
    new Setting(containerEl).setName('First-line indent').setDesc('First-line indent in em for body paragraphs; 0 = no indent. Only affects body paragraphs — headings / lists / quotes untouched')
      .addSlider((t) => t.setLimits(0, 4, 0.5).setValue(clamp(Number(p.settings.typoIndent) || 0, 0, 4)).setDynamicTooltip().onChange(async (v) => { p.settings.typoIndent = v; p.applyTypo(); p.scheduleSave(); }));
    new Setting(containerEl).setName('Paragraph spacing (reading view)').setDesc('Extra spacing between paragraphs in reading view (px); editing view is naturally controlled by blank lines and unaffected')
      .addSlider((t) => t.setLimits(0, 48, 2).setValue(clamp(Number(p.settings.typoParaGap) || 0, 0, 48)).setDynamicTooltip().onChange(async (v) => { p.settings.typoParaGap = v; p.applyTypo(); p.scheduleSave(); }));
    new Setting(containerEl).setName('Body font size').setDesc('0 = follow Obsidian\'s "Settings → Appearance → Font size"; 12~28px. If line heights look off after a change, switch files once to reset')
      .addSlider((t) => t.setLimits(0, 28, 1).setValue(clamp(Number(p.settings.typoFontSize) || 0, 0, 28)).setDynamicTooltip().onChange(async (v) => { p.settings.typoFontSize = v; p.applyTypo(); p.scheduleSave(); }));

    /* ===== Lore note "Appears In" stats (kept) ===== */
    containerEl.createEl('h3', { text: 'Lore note stats' });
    new Setting(containerEl).setName('Auto-track "Appears In" chapters in lore notes').setDesc('Each lore md note gets an auto-generated "📍 Appears In" table at the end: appearance counts + chapter links (click to jump), refreshed automatically as the body changes')
      .addToggle((t) => t.setValue(p.settings.appearSync !== false).onChange(async (v) => { p.settings.appearSync = v; await p.saveNow(); if (v) await p.syncEntityAppearances(); }));
    new Setting(containerEl).setName('Refresh "Appears In" stats now').setDesc('Manually trigger a rebuild of "Appears In" tables in all lore notes')
      .addButton((b) => b.setButtonText('Refresh').onClick(async () => { await p.syncEntityAppearances(); new Notice('"Appears In" stats updated'); }));

    /* ===== v2.4 independent axis toggles ===== */
    containerEl.createEl('h3', { text: 'Time / Location / Emotion Lines' });
    const axesDesc = containerEl.createDiv();
    axesDesc.style.cssText = 'font-size:11px;color:var(--text-muted);line-height:1.6;margin-bottom:10px';
    axesDesc.textContent = 'Each of the three line types can be toggled and combined freely: show only timelines, only location lines, only emotion lines, or compare them all. Every line can be renamed, duplicated, and linked to characters / plots / lore.';
    TRACK_AXES.forEach((a) => {
      new Setting(containerEl).setName(a.emoji + ' ' + a.name).setDesc('Show in the lines view' + a.name + '(multiple allowed)')
        .addToggle((t) => t.setValue(p.axisOn(a.key)).onChange(async (v) => {
          const cur = p.visibleAxes().slice();
          const i = cur.indexOf(a.key);
          if (v && i < 0) cur.push(a.key);
          if (!v && i >= 0 && cur.length > 1) cur.splice(i, 1);
          p.settings.visibleAxes = TRACK_AXES.map((x) => x.key).filter((k) => cur.indexOf(k) >= 0);
          await p.saveNow(); p.refreshViews();
        }));
    });

    /* ===== v2.1 word counts / goals / focus ===== */
    containerEl.createEl('h3', { text: 'Word goals & progress bar' });
    new Setting(containerEl).setName('Default word goal per chapter').setDesc('Default goal for new chapters; a single chapter can override it by clicking its word count in the catalog')
      .addText((t) => t.setValue(String(p.settings.chapterTarget || DEFAULT_CHAPTER_TARGET)).onChange(async (v) => {
        p.settings.chapterTarget = parseInt(v, 10) || DEFAULT_CHAPTER_TARGET; await p.saveNow(); p.refreshProgressBar();
      }));
    new Setting(containerEl).setName('Top floating gradient progress bar').setDesc('When the body opens, a gradient progress bar at the top shows: current words / goal, percent, how much is left, live writing pace')
      .addToggle((t) => t.setValue(p.settings.showProgressBar !== false).onChange(async (v) => { p.settings.showProgressBar = v; await p.saveNow(); p.refreshProgressBar(); }));
    new Setting(containerEl).setName('Pace tracking window (s)').setDesc('Live pace = words typed in the last N seconds converted to words / minute')
      .addText((t) => t.setValue(String(p.settings.paceWindow || 60)).onChange(async (v) => { p.settings.paceWindow = parseInt(v, 10) || 60; await p.saveNow(); }));

    containerEl.createEl('h3', { text: 'Pomodoro / Focus Mode' });
    const minClamp = (v, d) => { const n = parseInt(v, 10); return (n >= 1 && n <= 600) ? n : d; };
    new Setting(containerEl).setName('Pomodoro focus (min)').setDesc('Any 1-600 minutes, e.g. 5')
      .addText((t) => t.setValue(String(p.settings.pomodoroWork)).onChange(async (v) => { p.settings.pomodoroWork = minClamp(v, 25); await p.saveNow(); }));
    new Setting(containerEl).setName('Pomodoro short break (min)').addText((t) => t.setValue(String(p.settings.pomodoroBreak)).onChange(async (v) => { p.settings.pomodoroBreak = minClamp(v, 5); await p.saveNow(); }));
    new Setting(containerEl).setName('Pomodoro long break (min)').addText((t) => t.setValue(String(p.settings.pomodoroLongBreak)).onChange(async (v) => { p.settings.pomodoroLongBreak = minClamp(v, 15); await p.saveNow(); }));
    new Setting(containerEl).setName('Rounds before long break').addText((t) => t.setValue(String(p.settings.pomodoroRounds)).onChange(async (v) => { p.settings.pomodoroRounds = clamp(parseInt(v, 10) || 4, 1, 10); await p.saveNow(); }));
    new Setting(containerEl).setName('Custom focus (min)').addText((t) => t.setValue(String(p.settings.focusMinutes)).onChange(async (v) => { p.settings.focusMinutes = minClamp(v, 25); await p.saveNow(); }));
    const wpNote = containerEl.createDiv();
    wpNote.style.cssText = 'font-size:11px;color:var(--text-muted);line-height:1.6;margin:6px 0';
    wpNote.textContent = 'Available wallpapers: ' + FOCUS_WALLPAPERS.map((w) => w.name).join(' / ') + 'Dark ones are brightened with layered color; a translucent card under the body keeps text readable.';
    new Setting(containerEl).setName('Focus wallpaper')
      .addDropdown((d) => d.addOptions(FOCUS_WALLPAPERS.reduce((o, w) => { o[w.id] = w.name; return o; }, {})).setValue(p.settings.focusWallpaper).onChange(async (v) => { p.settings.focusWallpaper = v; await p.saveNow(); p.applyFocusWallpaper(v); }));
    new Setting(containerEl).setName('Auto fullscreen on focus').setDesc('When on, clicking "Start Focus" hides both sidebars and goes system fullscreen; exiting focus restores everything')
      .addToggle((t) => t.setValue(p.settings.focusFullscreen !== false).onChange(async (v) => { p.settings.focusFullscreen = v; await p.saveNow(); }));
    new Setting(containerEl).setName('Background dimming').setDesc('How much the UI dims during focus, 0 = no dimming, 90% = nearly black; darker helps concentration')
      .addSlider((s) => s.setLimits(0, 90, 5).setValue(Math.round((Number(p.settings.focusDim) || 0) * 100)).onChange(async (v) => { p.settings.focusDim = v / 100; await p.saveNow(); if (p.focusState.active) p.applyFocusWallpaper(p.settings.focusWallpaper); }));
    new Setting(containerEl).setName('Typing sound (per keypress)').setDesc('One beep per keypress, independent of ambient sound; only fires on real input')
      .addDropdown((d) => d.addOptions(TYPING_SOUNDS.reduce((o, s) => { o[s.id] = s.name; return o; }, {})).setValue(p.settings.typeSound || 'off').onChange(async (v) => { p.settings.typeSound = v; await p.saveNow(); if (v !== 'off') p.playTypeSound(true); }));
    new Setting(containerEl).setName('Typing sound volume (0-1)').addText((t) => t.setValue(String(p.settings.typeSoundVolume != null ? p.settings.typeSoundVolume : 0.35)).onChange(async (v) => { p.settings.typeSoundVolume = clamp(Number(v) || 0, 0, 1); await p.saveNow(); }));
    new Setting(containerEl).setName('Ambient sound (looping)').setDesc('Looping ambience like rain / white noise, usable during focus or anytime; pick "Off" to mute')
      .addDropdown((d) => d.addOptions(FOCUS_SOUNDS.reduce((o, s) => { o[s.id] = s.name; return o; }, {})).setValue(p.settings.focusSound).onChange(async (v) => { p.settings.focusSound = v; await p.saveNow(); }));
    new Setting(containerEl).setName('Ambient sound volume (0-1)').addText((t) => t.setValue(String(p.settings.focusSoundVolume)).onChange(async (v) => { p.settings.focusSoundVolume = clamp(Number(v) || 0, 0, 1); await p.saveNow(); }));
    new Setting(containerEl).setName('Typing mode (current paragraph highlighted · others fade)').setDesc('Highlights the paragraph under the cursor and fades surrounding ones to keep attention centered')
      .addToggle((t) => t.setValue(!!p.settings.typingMode).onChange(async (v) => { p.settings.typingMode = v; p.entityVersion++; await p.saveNow(); }));
    new Setting(containerEl).setName('Faded paragraphs').addText((t) => t.setValue(String(p.settings.typingRadius || 2)).onChange(async (v) => { p.settings.typingRadius = Math.max(1, parseInt(v, 10) || 2); p.entityVersion++; await p.saveNow(); }));

    new Setting(containerEl).setName('Lore file layout').setDesc('Lore is sorted by category into Lore/<Category>/<Name>.md, one subfolder per category; category and type are also written to frontmatter (nws_group / nws_type), body filled from the template. Existing flat files are auto-moved into their subfolder on load.');

    containerEl.createEl('h3', { text: 'Lore categories (6 + Standalone)' });
    const groupNote = containerEl.createDiv();
    groupNote.style.cssText = 'font-size:11px;color:var(--text-muted);line-height:1.7;margin-bottom:8px';
    groupNote.innerHTML = 'Each lore entry first picks a category, then a library under it; every library has its own template. Anything unclassifiable goes to "Standalone".'
      + ENTITY_GROUPS.map((g) => '<br>· <b>' + g.emoji + ' ' + g.name + '</b>：' + g.libs.join(' / ')).join('');

    containerEl.createEl('h3', { text: 'Library default colors (for colored bold in the body)' });
    const typeNote = containerEl.createDiv();
    typeNote.style.cssText = 'font-size:11px;color:var(--text-muted);line-height:1.6;margin-bottom:6px';
    typeNote.textContent = 'Default color per library; in "New Lore / Change highlight color" a single entry can also pick "No color (bold + underline)".';
    p.data.entityTypes.forEach((t) => {
      const row = new Setting(containerEl).setName(typeEmoji(t) + ' ' + t);
      PALETTE_NAMES.forEach((cn, ci) => {
        row.addButton((b) => {
          b.setTooltip(t + ' → ' + cn + '');
          b.setButtonText(p.typeColor(t) === ci ? '●' : '○');
          b.onClick(async () => { p.data.typeColors[t] = ci; p.entityVersion++; await p.saveNow(); this.display(); });
        });
      });
    });
    new Setting(containerEl).setName('Add lore type').addText((t) => t.setPlaceholder('e.g. Emotion')
      .addButton((b) => b.setButtonText('Add').onClick(async () => {
        const v = t.getValue().trim();
        if (v && p.data.entityTypes.indexOf(v) < 0) { p.data.entityTypes.push(v); p.data.typeColors[v] = 2; await p.saveNow(); this.display(); }
      })));

    containerEl.createEl('h3', { text: 'Outline types & templates' });
    const otNote = containerEl.createDiv();
    otNote.style.cssText = 'font-size:11px;color:var(--text-muted);line-height:1.7;margin-bottom:8px';
    otNote.innerHTML = 'Each outline type maps to a template skeleton; on creation a same-name md note is written — fill it in from the template:'
      + Object.keys(OUTLINE_TEMPLATES).map((k) => '<br>· <b>' + outlineEmoji(k) + ' ' + k + '</b>：' + OUTLINE_TEMPLATES[k].fields.join(' / ')).join('');
    new Setting(containerEl).setName('Add outline type').setDesc('New types reuse the "Custom" template skeleton (description / key points / linked items / notes)')
      .addText((t) => t.setPlaceholder('e.g. Conflict')
      .addButton((b) => b.setButtonText('Add').onClick(async () => {
        const v = t.getValue().trim();
        if (v && p.data.outlineTypes.indexOf(v) < 0) { p.data.outlineTypes.push(v); await p.saveNow(); this.display(); }
      })));

    /* ===== v1.0: Planning & scenes ===== */
    containerEl.createEl('h3', { text: 'Planning & scenes' });
    const planNote = containerEl.createDiv();
    planNote.style.cssText = 'font-size:11px;color:var(--text-muted);line-height:1.7;margin-bottom:8px';
    planNote.innerHTML = 'Four new modules, all optional and local-first:'
      + '<br>· <b>Gantt chart</b> — schedule chapters or standalone tasks on a timeline with progress.'
      + '<br>· <b>Release plan</b> — track platform, date and publishing status.'
      + '<br>· <b>Story scenes</b> — scene cards for beats, POV, location and time.'
      + '<br>· <b>Writing scenes</b> — presets that bundle wallpaper, sounds, focus and typography.';
    new Setting(containerEl).setName('Writing scene presets').setDesc('Create, rename, apply or delete presets that restore a whole writing atmosphere in one click')
      .addButton((b) => b.setButtonText('Manage presets').onClick(() => new ScenePresetModal(this.app, p).open()));
    new Setting(containerEl).setName('Save current setup as preset').setDesc('Capture the current wallpaper, sounds, focus behavior and typography into a named preset')
      .addButton((b) => b.setButtonText('Save…').onClick(() => new InputModal(this.app, 'Save current setup', 'e.g. Rainy Night Draft', async (v) => {
        if (!v.trim()) return; await p.saveScenePreset(v); new Notice('Scene preset saved: ' + v.trim()); this.display();
      }).open()));

    containerEl.createEl('h3', { text: 'Story scene custom fields' });
    const sfNote = containerEl.createDiv();
    sfNote.style.cssText = 'font-size:11px;color:var(--text-muted);line-height:1.7;margin-bottom:8px';
    sfNote.textContent = 'Fields shown on every story scene card (e.g. POV, Location, Time, Mood). Add your own or remove the defaults.';
    (p.data.sceneFields || []).forEach((f) => {
      new Setting(containerEl).setName(f.name)
        .addExtraButton((b) => b.setIcon('trash').setTooltip('Remove field').onClick(async () => {
          await p.deleteSceneField(f.key); this.display();
        }));
    });
    new Setting(containerEl).setName('Add custom scene field')
      .addText((t) => t.setPlaceholder('e.g. Conflict')
      .addButton((b) => b.setButtonText('Add').onClick(async () => {
        const v = t.getValue().trim();
        if (v && await p.addSceneField(v)) { new Notice('Custom field added: ' + v); this.display(); }
      })));
  }
}

/* ==================================================================
   v1.0 — Planning & Scenes expansion
/* ==================================================================
   v1.0 — Planning & Scenes expansion
   Modules: Gantt chart / Release plan / Story scene cards / Writing scene presets
   All user-facing strings are in English.
   ================================================================== */
const VIEW_GANTT = 'nws-gantt';
const VIEW_RELEASE = 'nws-release';
const VIEW_SCENES = 'nws-scenes';

const RELEASE_STATUSES = ['Idea', 'Scheduled', 'Drafting', 'Published'];
const SCENE_STATUSES = ['Outline', 'Draft', 'Revised', 'Final'];

const PRESET_KEYS = [
  'focusWallpaper', 'focusSound', 'focusSoundVolume', 'typeSound', 'typeSoundVolume',
  'focusDim', 'focusFullscreen', 'typingMode', 'typingRadius',
  'typoEnabled', 'typoLineHeight', 'typoLetterSpacing', 'typoIndent', 'typoParaGap', 'typoFontSize',
  'dialogueHighlight', 'entityHighlight'
];

function defaultScenePresets() {
  return [
    { id: 'preset_midnight', name: 'Midnight Novelist', icon: '\u{1F319}', settings: {
      focusWallpaper: 'midnight', focusSound: 'rain', focusSoundVolume: 0.3,
      typeSound: 'type', typeSoundVolume: 0.35, focusDim: 0.32, focusFullscreen: true,
      typingMode: false, typingRadius: 2, typoEnabled: true, typoLineHeight: 1.9,
      typoLetterSpacing: 0, typoIndent: 2, typoParaGap: 8, typoFontSize: 0,
      dialogueHighlight: true, entityHighlight: true } },
    { id: 'preset_morning', name: 'Morning Draft', icon: '\u{1F324}', settings: {
      focusWallpaper: 'sand', focusSound: 'off', focusSoundVolume: 0,
      typeSound: 'soft', typeSoundVolume: 0.35, focusDim: 0.12, focusFullscreen: false,
      typingMode: false, typingRadius: 2, typoEnabled: true, typoLineHeight: 1.75,
      typoLetterSpacing: 0, typoIndent: 2, typoParaGap: 6, typoFontSize: 0,
      dialogueHighlight: true, entityHighlight: true } },
    { id: 'preset_cafe', name: 'Cafe Write', icon: '\u2615', settings: {
      focusWallpaper: 'espresso', focusSound: 'noise', focusSoundVolume: 0.25,
      typeSound: 'key', typeSoundVolume: 0.3, focusDim: 0.22, focusFullscreen: false,
      typingMode: false, typingRadius: 2, typoEnabled: true, typoLineHeight: 1.7,
      typoLetterSpacing: 0.02, typoIndent: 0, typoParaGap: 10, typoFontSize: 0,
      dialogueHighlight: true, entityHighlight: true } }
  ];
}

function parseDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
}
function dayAdd(ts, n) { return ts + n * 86400000; }
function dayStr(ts) {
  const d = new Date(ts);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}
function todayTs() { const d = new Date(); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()); }
function nameOfId(list, id) { const x = (list || []).find((o) => o.id === id); return x ? x.name : (id || '-'); }

/* ---------- Plugin methods (mixed in; NovelWriterStudio is defined above) ---------- */
Object.assign(NovelWriterStudio.prototype, {
  chapterTitleOf(path) {
    const c = (this.allChapters() || []).find((x) => x.path === path);
    return c ? c.title : String(path || '').split('/').pop().replace(/\.md$/, '');
  },
  chapterOptionHtml(selected) {
    const chapters = this.allChapters() || [];
    let s = '<option value="">- Not bound to a chapter -</option>';
    chapters.forEach((c) => {
      s += '<option value="' + escapeHtml(c.path) + '"' + (c.path === selected ? ' selected' : '') + '>'
        + escapeHtml(c.volume + ' / ' + c.title) + '</option>';
    });
    if (selected && !chapters.some((c) => c.path === selected)) {
      s += '<option value="' + escapeHtml(selected) + '" selected>' + escapeHtml(this.chapterTitleOf(selected)) + ' (missing)</option>';
    }
    return s;
  },

  /* Gantt */
  ganttById(id) { return (this.data.ganttTasks || []).find((t) => t.id === id); },
  async addGanttTask(patch) {
    const t = Object.assign({ id: uid(), title: 'New task', chapter: '', start: dateKey(), end: dateKey(), progress: 0, color: 0, notes: '' }, patch || {});
    this.data.ganttTasks.push(t); await this.saveNow(); this.refreshViews(); return t;
  },
  async updateGanttTask(id, patch) { const t = this.ganttById(id); if (!t) return; Object.assign(t, patch); await this.saveNow(); this.refreshViews(); },
  async deleteGanttTask(id) { this.data.ganttTasks = this.data.ganttTasks.filter((t) => t.id !== id); await this.saveNow(); this.refreshViews(); },
  async moveGanttTask(id, dir) {
    const a = this.data.ganttTasks, i = a.findIndex((t) => t.id === id), j = i + dir;
    if (i < 0 || j < 0 || j >= a.length) return;
    const tmp = a[i]; a[i] = a[j]; a[j] = tmp; await this.saveNow(); this.refreshViews();
  },

  /* Release plan */
  releaseById(id) { return (this.data.releases || []).find((r) => r.id === id); },
  async addRelease(patch) {
    const r = Object.assign({ id: uid(), title: 'New release', chapter: '', platform: '', date: '', status: RELEASE_STATUSES[0], notes: '' }, patch || {});
    this.data.releases.push(r); await this.saveNow(); this.refreshViews(); return r;
  },
  async updateRelease(id, patch) { const r = this.releaseById(id); if (!r) return; Object.assign(r, patch); await this.saveNow(); this.refreshViews(); },
  async deleteRelease(id) { this.data.releases = this.data.releases.filter((r) => r.id !== id); await this.saveNow(); this.refreshViews(); },
  async moveRelease(id, dir) {
    const a = this.data.releases, i = a.findIndex((r) => r.id === id), j = i + dir;
    if (i < 0 || j < 0 || j >= a.length) return;
    const tmp = a[i]; a[i] = a[j]; a[j] = tmp; await this.saveNow(); this.refreshViews();
  },

  /* Story scenes */
  sceneById(id) { return (this.data.sceneCards || []).find((s) => s.id === id); },
  async addSceneCard(patch) {
    const s = Object.assign({ id: uid(), title: 'New scene', chapter: '', status: SCENE_STATUSES[0], summary: '', fields: {}, color: 0 }, patch || {});
    this.data.sceneCards.push(s); await this.saveNow(); this.refreshViews(); return s;
  },
  async updateSceneCard(id, patch) { const s = this.sceneById(id); if (!s) return; Object.assign(s, patch); await this.saveNow(); this.refreshViews(); },
  async deleteSceneCard(id) { this.data.sceneCards = this.data.sceneCards.filter((s) => s.id !== id); await this.saveNow(); this.refreshViews(); },
  async moveSceneCard(id, dir) {
    const a = this.data.sceneCards, i = a.findIndex((s) => s.id === id), j = i + dir;
    if (i < 0 || j < 0 || j >= a.length) return;
    const tmp = a[i]; a[i] = a[j]; a[j] = tmp; await this.saveNow(); this.refreshViews();
  },

  /* Custom scene fields */
  async addSceneField(name) {
    const v = String(name || '').trim();
    if (!v || (this.data.sceneFields || []).some((f) => f.name === v)) return false;
    this.data.sceneFields.push({ key: uid(), name: v });
    await this.saveNow(); return true;
  },
  async deleteSceneField(key) {
    this.data.sceneFields = (this.data.sceneFields || []).filter((f) => f.key !== key);
    (this.data.sceneCards || []).forEach((s) => { if (s.fields) delete s.fields[key]; });
    await this.saveNow(); this.refreshViews();
  },

  /* Writing scene presets */
  presetById(id) { return (this.data.scenePresets || []).find((p) => p.id === id); },
  async applyScenePreset(id) {
    const pr = this.presetById(id); if (!pr) return;
    PRESET_KEYS.forEach((k) => { if (pr.settings[k] !== undefined) this.settings[k] = pr.settings[k]; });
    try { this.applyTypo(); } catch (e) { /* ignore */ }
    try { document.body.classList.toggle('nws-typo-on', this.settings.typoEnabled !== false); } catch (e) { /* ignore */ }
    await this.saveNow(); this.refreshViews();
    new Notice('Scene preset applied: ' + pr.name);
  },
  async saveScenePreset(name) {
    const settings = {};
    PRESET_KEYS.forEach((k) => { settings[k] = this.settings[k]; });
    const pr = { id: uid(), name: String(name || '').trim() || 'Untitled scene', icon: '\u270D\uFE0F', settings };
    this.data.scenePresets.push(pr); await this.saveNow(); return pr;
  },
  async deleteScenePreset(id) {
    this.data.scenePresets = (this.data.scenePresets || []).filter((p) => p.id !== id);
    await this.saveNow();
  }
});

/* ================= Gantt chart ================= */
class GanttView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; }
  getViewType() { return VIEW_GANTT; }
  getDisplayText() { return 'Studio - Gantt Chart'; }
  getIcon() { return 'calendar-range'; }
  async onOpen() { this.render(); }

  render() {
    const p = this.plugin;
    const tasks = (p.data.ganttTasks || []).slice();
    const now = todayTs();
    let lo = now, hi = dayAdd(now, 30);
    tasks.forEach((t) => {
      const a = parseDay(t.start), b = parseDay(t.end);
      if (a != null) lo = Math.min(lo, a);
      if (b != null) hi = Math.max(hi, b);
    });
    lo = dayAdd(lo, -2); hi = dayAdd(hi, 3);
    const span = Math.max(1, Math.round((hi - lo) / 86400000));
    const stepDays = span > 120 ? 14 : span > 60 ? 7 : span > 21 ? 3 : 1;
    const colW = stepDays <= 1 ? 26 : 58;
    const width = Math.max(600, Math.ceil(span / stepDays + 1) * colW);

    let ticks = '';
    for (let d = lo; d <= hi; d = dayAdd(d, stepDays)) {
      ticks += '<div class="nws-gantt-tick" style="width:' + colW + 'px">' + escapeHtml(dayStr(d).slice(5)) + '</div>';
    }
    const todayLeft = ((now - lo) / 86400000) / span * 100;

    const rows = tasks.map((t) => {
      const a = parseDay(t.start), b = parseDay(t.end);
      const s = a == null ? now : a, e = b == null ? s : Math.max(s, b);
      const left = ((s - lo) / 86400000) / span * 100;
      const w = Math.max(1.2, ((e - s) / 86400000 + 1) / span * 100);
      const pr = clamp(Number(t.progress) || 0, 0, 100);
      const color = PALETTE[(Number(t.color) || 0) % PALETTE.length];
      const ch = t.chapter
        ? '<span class="nws-gantt-ch" data-gch="' + escapeHtml(t.chapter) + '">\u{1F4C4} ' + escapeHtml(p.chapterTitleOf(t.chapter)) + '</span>'
        : '<span class="nws-gantt-ch muted">Unbound task</span>';
      return '<div class="nws-gantt-row" data-gid="' + escapeHtml(t.id) + '">'
        + '<div class="nws-gantt-label"><div class="nws-gantt-name">' + escapeHtml(t.title) + '</div>' + ch
        + '<div class="nws-gantt-meta">' + escapeHtml(dayStr(s)) + ' \u2192 ' + escapeHtml(dayStr(e)) + '</div>'
        + '<div class="nws-gantt-ctl"><button class="nws-btn sm" data-ga="edit" title="Edit task">\u270E</button>'
        + '<button class="nws-btn sm" data-ga="up" title="Move up">\u2191</button>'
        + '<button class="nws-btn sm" data-ga="down" title="Move down">\u2193</button>'
        + '<button class="nws-btn sm" data-ga="del" title="Delete task">\u2715</button></div></div>'
        + '<div class="nws-gantt-track" style="width:' + width + 'px">'
        + '<div class="nws-gantt-today" style="left:' + todayLeft + '%"></div>'
        + '<div class="nws-gantt-bar" style="left:' + left + '%;width:' + w + '%;background:' + color + '" title="'
        + escapeHtml(t.title + ' | ' + dayStr(s) + ' to ' + dayStr(e) + ' | ' + pr + '%') + '">'
        + '<div class="nws-gantt-fill" style="width:' + pr + '%"></div><span>' + pr + '%</span></div>'
        + '</div></div>';
    }).join('');

    const root = setViewRoot(this,
      '<div class="nws-phead"><div class="nws-row"><div class="nws-ptitle">Gantt Chart <span class="nws-tag">'
      + tasks.length + ' tasks</span></div><div class="nws-sp"></div>'
      + '<button class="nws-fold" data-view="release">Release Plan</button>'
      + '<button class="nws-fold" data-view="scenes">Story Scenes</button>'
      + '<button class="nws-btn pri" data-act="newtask">+ New Task</button></div>'
      + '<div class="nws-psub">Timeline of chapters or standalone tasks. Each task has start / end dates and a progress bar; a chapter link is optional. Click a chapter chip to jump to the manuscript.</div></div>'
      + '<div class="nws-gantt-scroll"><div class="nws-gantt-head"><div class="nws-gantt-labelhead">Task</div>'
      + '<div class="nws-gantt-ticks" style="width:' + width + 'px">' + ticks + '</div></div>'
      + '<div class="nws-gantt-body">' + (rows || '<div class="nws-empty">No tasks yet. Click "+ New Task" to create the first one.</div>') + '</div></div>');

    root.querySelector('[data-act="newtask"]').addEventListener('click', () => new GanttTaskModal(this.app, p, null).open());
    root.querySelector('[data-view="release"]').addEventListener('click', () => p.activateView(VIEW_RELEASE));
    root.querySelector('[data-view="scenes"]').addEventListener('click', () => p.activateView(VIEW_SCENES));
    root.querySelectorAll('.nws-gantt-row').forEach((row) => {
      const id = row.dataset.gid;
      row.querySelectorAll('[data-ga]').forEach((b) => b.addEventListener('click', () => {
        const a = b.dataset.ga;
        if (a === 'edit') new GanttTaskModal(this.app, p, p.ganttById(id)).open();
        else if (a === 'del') { if (confirm('Delete this task?')) p.deleteGanttTask(id); }
        else if (a === 'up') p.moveGanttTask(id, -1);
        else if (a === 'down') p.moveGanttTask(id, 1);
      }));
    });
    root.querySelectorAll('[data-gch]').forEach((c) => c.addEventListener('click', () => p.openChapterByPath(c.dataset.gch)));
  }
}

class GanttTaskModal extends Modal {
  constructor(app, plugin, task) { super(app); this.p = plugin; this.task = task; }
  onOpen() {
    const p = this.p, t = this.task, { contentEl } = this;
    contentEl.createEl('h3', { text: t ? 'Edit task - ' + t.title : 'New Gantt task' });
    const mk = (label) => {
      const r = contentEl.createDiv(); r.style.cssText = 'margin:8px 0';
      r.createSpan({ text: label }).style.cssText = 'display:block;font-size:11px;color:var(--text-muted);margin-bottom:3px';
      return r;
    };
    const title = mk('Task title').createEl('input'); title.type = 'text'; title.style.width = '100%';
    title.value = t ? t.title : ''; title.placeholder = 'e.g. Draft chapter 3';
    const chapSel = mk('Bind to chapter (optional)').createEl('select'); chapSel.style.width = '100%';
    chapSel.innerHTML = p.chapterOptionHtml(t ? t.chapter : '');
    const dr = contentEl.createDiv(); dr.style.cssText = 'display:flex;gap:8px;margin:8px 0';
    const d1 = el('div'); d1.style.cssText = 'flex:1'; d1.createSpan({ text: 'Start date' }).style.cssText = 'display:block;font-size:11px;color:var(--text-muted);margin-bottom:3px';
    const start = d1.createEl('input'); start.type = 'date'; start.style.width = '100%'; start.value = t ? t.start : dateKey();
    const d2 = el('div'); d2.style.cssText = 'flex:1'; d2.createSpan({ text: 'End date' }).style.cssText = 'display:block;font-size:11px;color:var(--text-muted);margin-bottom:3px';
    const end = d2.createEl('input'); end.type = 'date'; end.style.width = '100%'; end.value = t ? t.end : dateKey();
    dr.appendChild(d1); dr.appendChild(d2);
    const prRow = mk('Progress'); const prog = prRow.createEl('input');
    prog.type = 'range'; prog.min = '0'; prog.max = '100'; prog.step = '5'; prog.style.width = '75%';
    prog.value = String(t ? t.progress : 0);
    const prLbl = prRow.createSpan({ text: ' ' + prog.value + '%' }); prLbl.style.cssText = 'font-size:11px';
    prog.addEventListener('input', () => { prLbl.textContent = ' ' + prog.value + '%'; });
    const colorSel = mk('Color').createEl('select'); colorSel.style.width = '100%';
    colorSel.innerHTML = PALETTE_NAMES.map((n, i) => '<option value="' + i + '"' + ((t ? t.color : 0) === i ? ' selected' : '') + '>' + escapeHtml(n) + '</option>').join('');
    const notes = mk('Notes').createEl('textarea'); notes.style.cssText = 'width:100%;height:64px'; notes.value = t ? t.notes : '';

    const row = contentEl.createDiv(); row.style.cssText = 'margin-top:14px;text-align:right';
    const cancel = row.createEl('button', { text: 'Cancel' }); cancel.addEventListener('click', () => this.close());
    const save = row.createEl('button', { text: t ? 'Save' : 'Create' }); save.className = 'mod-cta'; save.style.marginLeft = '8px';
    save.addEventListener('click', async () => {
      if (!title.value.trim()) { new Notice('Please enter a task title'); return; }
      if (parseDay(end.value) != null && parseDay(start.value) != null && end.value < start.value) { new Notice('End date cannot be before start date'); return; }
      const patch = { title: title.value.trim(), chapter: chapSel.value, start: start.value, end: end.value, progress: Number(prog.value) || 0, color: Number(colorSel.value) || 0, notes: notes.value };
      if (t) await p.updateGanttTask(t.id, patch); else await p.addGanttTask(patch);
      this.close();
    });
  }
  onClose() { this.contentEl.empty(); }
}

/* ================= Release plan ================= */
class ReleaseView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.filter = 'All'; }
  getViewType() { return VIEW_RELEASE; }
  getDisplayText() { return 'Studio - Release Plan'; }
  getIcon() { return 'send'; }
  async onOpen() { this.render(); }

  render() {
    const p = this.plugin;
    const items = (p.data.releases || []).slice().sort((a, b) => String(a.date || '9999').localeCompare(String(b.date || '9999')));
    const counts = {}; RELEASE_STATUSES.forEach((s) => { counts[s] = 0; });
    items.forEach((r) => { if (counts[r.status] != null) counts[r.status]++; });
    const filters = '<button class="nws-fbtn ' + (this.filter === 'All' ? 'on' : '') + '" data-rf="All">All <span class="nws-cnt">' + items.length + '</span></button>'
      + RELEASE_STATUSES.map((s) => '<button class="nws-fbtn ' + (this.filter === s ? 'on' : '') + '" data-rf="' + escapeHtml(s) + '">' + escapeHtml(s) + ' <span class="nws-cnt">' + counts[s] + '</span></button>').join('');
    const shown = this.filter === 'All' ? items : items.filter((r) => r.status === this.filter);
    const rows = shown.map((r) => {
      const ch = r.chapter
        ? '<span class="nws-rel-ch" data-rch="' + escapeHtml(r.chapter) + '">\u{1F4C4} ' + escapeHtml(p.chapterTitleOf(r.chapter)) + '</span>'
        : '<span class="nws-rel-ch muted">Unbound</span>';
      return '<div class="nws-rel-row" data-rid="' + escapeHtml(r.id) + '">'
        + '<div class="nws-rel-main"><div class="nws-rel-title">' + escapeHtml(r.title) + '</div>'
        + '<div class="nws-rel-meta">' + ch
        + '<span class="nws-rel-plat">\u{1F3E2} ' + escapeHtml(r.platform || 'Platform not set') + '</span>'
        + '<span class="nws-rel-date">\u{1F4C5} ' + escapeHtml(r.date || 'Date not set') + '</span></div>'
        + (r.notes ? '<div class="nws-rel-notes">' + escapeHtml(r.notes) + '</div>' : '') + '</div>'
        + '<select class="nws-rel-status" data-rstatus="' + escapeHtml(r.id) + '">'
        + RELEASE_STATUSES.map((s) => '<option value="' + escapeHtml(s) + '"' + (r.status === s ? ' selected' : '') + '>' + escapeHtml(s) + '</option>').join('')
        + '</select>'
        + '<div class="nws-rel-ctl"><button class="nws-btn sm" data-ra="edit" title="Edit">\u270E</button>'
        + '<button class="nws-btn sm" data-ra="up" title="Move up">\u2191</button>'
        + '<button class="nws-btn sm" data-ra="down" title="Move down">\u2193</button>'
        + '<button class="nws-btn sm" data-ra="del" title="Delete">\u2715</button></div></div>';
    }).join('');

    const root = setViewRoot(this,
      '<div class="nws-phead"><div class="nws-row"><div class="nws-ptitle">Release Plan <span class="nws-tag">' + items.length + ' items</span></div>'
      + '<div class="nws-sp"></div>'
      + '<button class="nws-fold" data-view="gantt">Gantt Chart</button>'
      + '<button class="nws-fold" data-view="scenes">Story Scenes</button>'
      + '<button class="nws-btn pri" data-act="new">+ New Release</button></div>'
      + '<div class="nws-psub">Track where and when each work is published. Every item can optionally link to a chapter; the status can be changed inline.</div>'
      + '<div class="nws-filters">' + filters + '</div></div>'
      + '<div class="nws-rel-list">' + (rows || '<div class="nws-empty">No release items yet. Click "+ New Release" to start a plan.</div>') + '</div>');

    root.querySelectorAll('[data-rf]').forEach((b) => b.addEventListener('click', () => { this.filter = b.dataset.rf; this.render(); }));
    root.querySelector('[data-act="new"]').addEventListener('click', () => new ReleaseModal(this.app, p, null).open());
    root.querySelector('[data-view="gantt"]').addEventListener('click', () => p.activateView(VIEW_GANTT));
    root.querySelector('[data-view="scenes"]').addEventListener('click', () => p.activateView(VIEW_SCENES));
    root.querySelectorAll('.nws-rel-row').forEach((row) => {
      const id = row.dataset.rid;
      row.querySelectorAll('[data-ra]').forEach((b) => b.addEventListener('click', () => {
        const a = b.dataset.ra;
        if (a === 'edit') new ReleaseModal(this.app, p, p.releaseById(id)).open();
        else if (a === 'del') { if (confirm('Delete this release item?')) p.deleteRelease(id); }
        else if (a === 'up') p.moveRelease(id, -1);
        else if (a === 'down') p.moveRelease(id, 1);
      }));
      const sel = row.querySelector('[data-rstatus]');
      sel.addEventListener('change', () => p.updateRelease(id, { status: sel.value }));
    });
    root.querySelectorAll('[data-rch]').forEach((c) => c.addEventListener('click', () => p.openChapterByPath(c.dataset.rch)));
  }
}

class ReleaseModal extends Modal {
  constructor(app, plugin, item) { super(app); this.p = plugin; this.item = item; }
  onOpen() {
    const p = this.p, it = this.item, { contentEl } = this;
    contentEl.createEl('h3', { text: it ? 'Edit release - ' + it.title : 'New release item' });
    const mk = (label) => {
      const r = contentEl.createDiv(); r.style.cssText = 'margin:8px 0';
      r.createSpan({ text: label }).style.cssText = 'display:block;font-size:11px;color:var(--text-muted);margin-bottom:3px';
      return r;
    };
    const title = mk('Title').createEl('input'); title.type = 'text'; title.style.width = '100%';
    title.value = it ? it.title : ''; title.placeholder = 'e.g. Serial launch on Patreon';
    const chap = mk('Bind to chapter (optional)').createEl('select'); chap.style.width = '100%';
    chap.innerHTML = p.chapterOptionHtml(it ? it.chapter : '');
    const plat = mk('Platform / channel').createEl('input'); plat.type = 'text'; plat.style.width = '100%';
    plat.value = it ? it.platform : ''; plat.placeholder = 'e.g. Patreon / Web novel site / Personal blog';
    const date = mk('Release date').createEl('input'); date.type = 'date'; date.value = it ? it.date : '';
    const st = mk('Status').createEl('select'); st.style.width = '100%';
    st.innerHTML = RELEASE_STATUSES.map((s) => '<option value="' + escapeHtml(s) + '"' + ((it ? it.status : RELEASE_STATUSES[0]) === s ? ' selected' : '') + '>' + escapeHtml(s) + '</option>').join('');
    const notes = mk('Notes').createEl('textarea'); notes.style.cssText = 'width:100%;height:64px'; notes.value = it ? it.notes : '';

    const row = contentEl.createDiv(); row.style.cssText = 'margin-top:14px;text-align:right';
    const cancel = row.createEl('button', { text: 'Cancel' }); cancel.addEventListener('click', () => this.close());
    const save = row.createEl('button', { text: it ? 'Save' : 'Create' }); save.className = 'mod-cta'; save.style.marginLeft = '8px';
    save.addEventListener('click', async () => {
      if (!title.value.trim()) { new Notice('Please enter a title'); return; }
      const patch = { title: title.value.trim(), chapter: chap.value, platform: plat.value.trim(), date: date.value, status: st.value, notes: notes.value };
      if (it) await p.updateRelease(it.id, patch); else await p.addRelease(patch);
      this.close();
    });
  }
  onClose() { this.contentEl.empty(); }
}

/* ================= Story scene cards ================= */
class ScenesView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.filter = 'All'; }
  getViewType() { return VIEW_SCENES; }
  getDisplayText() { return 'Studio - Story Scenes'; }
  getIcon() { return 'layout-grid'; }
  async onOpen() { this.render(); }

  render() {
    const p = this.plugin;
    const fields = p.data.sceneFields || [];
    const all = p.data.sceneCards || [];
    const counts = {}; SCENE_STATUSES.forEach((s) => { counts[s] = 0; });
    all.forEach((s) => { if (counts[s.status] != null) counts[s.status]++; });
    const filters = '<button class="nws-fbtn ' + (this.filter === 'All' ? 'on' : '') + '" data-sf="All">All <span class="nws-cnt">' + all.length + '</span></button>'
      + SCENE_STATUSES.map((s) => '<button class="nws-fbtn ' + (this.filter === s ? 'on' : '') + '" data-sf="' + escapeHtml(s) + '">' + escapeHtml(s) + ' <span class="nws-cnt">' + counts[s] + '</span></button>').join('');
    const shown = this.filter === 'All' ? all : all.filter((s) => s.status === this.filter);
    const cards = shown.map((s) => {
      const ch = s.chapter
        ? '<span class="nws-sc-ch" data-sch="' + escapeHtml(s.chapter) + '">\u{1F4C4} ' + escapeHtml(p.chapterTitleOf(s.chapter)) + '</span>'
        : '<span class="nws-sc-ch muted">Unbound</span>';
      const extra = fields.map((f) => {
        const v = (s.fields || {})[f.key];
        return v ? '<div class="nws-sc-f"><span>' + escapeHtml(f.name) + '</span><b>' + escapeHtml(v) + '</b></div>' : '';
      }).join('');
      const color = PALETTE[(Number(s.color) || 0) % PALETTE.length];
      return '<div class="nws-sc-card" data-sid="' + escapeHtml(s.id) + '" style="--nws-sc-color:' + color + '">'
        + '<div class="nws-sc-h"><div class="nws-sc-title">' + escapeHtml(s.title) + '</div>'
        + '<span class="nws-sc-status">' + escapeHtml(s.status) + '</span></div>'
        + '<div class="nws-sc-body">' + ch + (extra ? '<div class="nws-sc-fields">' + extra + '</div>' : '')
        + (s.summary ? '<div class="nws-sc-sum">' + escapeHtml(s.summary) + '</div>' : '') + '</div>'
        + '<div class="nws-sc-ctl"><button class="nws-btn sm" data-sa="edit" title="Edit scene">\u270E</button>'
        + '<button class="nws-btn sm" data-sa="up" title="Move up">\u2191</button>'
        + '<button class="nws-btn sm" data-sa="down" title="Move down">\u2193</button>'
        + '<button class="nws-btn sm" data-sa="del" title="Delete scene">\u2715</button></div></div>';
    }).join('');

    const root = setViewRoot(this,
      '<div class="nws-phead"><div class="nws-row"><div class="nws-ptitle">Story Scenes <span class="nws-tag">' + all.length + ' scenes</span></div>'
      + '<div class="nws-sp"></div>'
      + '<button class="nws-fold" data-view="gantt">Gantt Chart</button>'
      + '<button class="nws-fold" data-view="release">Release Plan</button>'
      + '<button class="nws-btn pri" data-act="new">+ New Scene</button></div>'
      + '<div class="nws-psub">Scene cards for beats, POV, location and time. Custom fields are managed in the plugin settings; each scene may optionally bind to a chapter.</div>'
      + '<div class="nws-filters">' + filters + '</div></div>'
      + '<div class="nws-sc-grid">' + (cards || '<div class="nws-empty">No scenes yet. Click "+ New Scene" to create the first card.</div>') + '</div>');

    root.querySelectorAll('[data-sf]').forEach((b) => b.addEventListener('click', () => { this.filter = b.dataset.sf; this.render(); }));
    root.querySelector('[data-act="new"]').addEventListener('click', () => new SceneCardModal(this.app, p, null).open());
    root.querySelector('[data-view="gantt"]').addEventListener('click', () => p.activateView(VIEW_GANTT));
    root.querySelector('[data-view="release"]').addEventListener('click', () => p.activateView(VIEW_RELEASE));
    root.querySelectorAll('.nws-sc-card').forEach((card) => {
      const id = card.dataset.sid;
      card.querySelectorAll('[data-sa]').forEach((b) => b.addEventListener('click', () => {
        const a = b.dataset.sa;
        if (a === 'edit') new SceneCardModal(this.app, p, p.sceneById(id)).open();
        else if (a === 'del') { if (confirm('Delete this scene card?')) p.deleteSceneCard(id); }
        else if (a === 'up') p.moveSceneCard(id, -1);
        else if (a === 'down') p.moveSceneCard(id, 1);
      }));
    });
    root.querySelectorAll('[data-sch]').forEach((c) => c.addEventListener('click', () => p.openChapterByPath(c.dataset.sch)));
  }
}

class SceneCardModal extends Modal {
  constructor(app, plugin, scene) { super(app); this.p = plugin; this.scene = scene; }
  onOpen() {
    const p = this.p, s = this.scene, { contentEl } = this;
    contentEl.createEl('h3', { text: s ? 'Edit scene - ' + s.title : 'New story scene' });
    const mk = (label) => {
      const r = contentEl.createDiv(); r.style.cssText = 'margin:8px 0';
      r.createSpan({ text: label }).style.cssText = 'display:block;font-size:11px;color:var(--text-muted);margin-bottom:3px';
      return r;
    };
    const title = mk('Scene title').createEl('input'); title.type = 'text'; title.style.width = '100%';
    title.value = s ? s.title : ''; title.placeholder = 'e.g. The rain scene at the station';
    const chap = mk('Bind to chapter (optional)').createEl('select'); chap.style.width = '100%';
    chap.innerHTML = p.chapterOptionHtml(s ? s.chapter : '');
    const st = mk('Status').createEl('select'); st.style.width = '100%';
    st.innerHTML = SCENE_STATUSES.map((x) => '<option value="' + escapeHtml(x) + '"' + ((s ? s.status : SCENE_STATUSES[0]) === x ? ' selected' : '') + '>' + escapeHtml(x) + '</option>').join('');
    const colorSel = mk('Color').createEl('select'); colorSel.style.width = '100%';
    colorSel.innerHTML = PALETTE_NAMES.map((n, i) => '<option value="' + i + '"' + ((s ? s.color : 0) === i ? ' selected' : '') + '>' + escapeHtml(n) + '</option>').join('');

    (p.data.sceneFields || []).forEach((f) => {
      const inp = mk(f.name).createEl('input'); inp.type = 'text'; inp.style.width = '100%';
      inp.value = s && s.fields ? (s.fields[f.key] || '') : '';
      inp.dataset.key = f.key;
    });

    const summary = mk('Summary / notes').createEl('textarea'); summary.style.cssText = 'width:100%;height:80px';
    summary.value = s ? s.summary : '';

    const row = contentEl.createDiv(); row.style.cssText = 'margin-top:14px;text-align:right';
    const cancel = row.createEl('button', { text: 'Cancel' }); cancel.addEventListener('click', () => this.close());
    const save = row.createEl('button', { text: s ? 'Save' : 'Create' }); save.className = 'mod-cta'; save.style.marginLeft = '8px';
    save.addEventListener('click', async () => {
      if (!title.value.trim()) { new Notice('Please enter a scene title'); return; }
      const fields = {};
      contentEl.querySelectorAll('input[data-key]').forEach((i) => { if (i.value.trim()) fields[i.dataset.key] = i.value.trim(); });
      const patch = { title: title.value.trim(), chapter: chap.value, status: st.value, color: Number(colorSel.value) || 0, fields, summary: summary.value };
      if (s) await p.updateSceneCard(s.id, patch); else await p.addSceneCard(patch);
      this.close();
    });
  }
  onClose() { this.contentEl.empty(); }
}

/* ================= Writing scene presets ================= */
class ScenePresetModal extends Modal {
  constructor(app, plugin) { super(app); this.p = plugin; }
  onOpen() { this.render(); }
  render() {
    const p = this.p, { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: 'Writing scene presets' });
    contentEl.createDiv({ text: 'A preset bundles wallpaper, ambient sound, typing sound, focus behavior and typography. Apply one to restore the whole writing atmosphere instantly.' })
      .style.cssText = 'font-size:11px;color:var(--text-muted);line-height:1.6;margin-bottom:10px';

    (p.data.scenePresets || []).forEach((pr) => {
      const row = contentEl.createDiv('nws-preset-row');
      const head = row.createDiv('nws-preset-head');
      head.createSpan({ text: (pr.icon || '\u270D\uFE0F') + ' ' + pr.name }).style.cssText = 'font-weight:600;font-size:12px';
      const desc = nameOfId(FOCUS_WALLPAPERS, pr.settings.focusWallpaper) + ' | ' + nameOfId(FOCUS_SOUNDS, pr.settings.focusSound)
        + ' | ' + nameOfId(TYPING_SOUNDS, pr.settings.typeSound) + ' | line height ' + (pr.settings.typoLineHeight || '-');
      row.createDiv({ text: desc }).style.cssText = 'font-size:10px;color:var(--text-muted);margin:3px 0 7px';
      const ctl = row.createDiv('nws-preset-ctl');
      const apply = ctl.createEl('button', { text: 'Apply' }); apply.className = 'mod-cta nws-btn sm';
      apply.addEventListener('click', async () => { await p.applyScenePreset(pr.id); this.render(); });
      const rename = ctl.createEl('button', { text: 'Rename' }); rename.className = 'nws-btn sm';
      rename.addEventListener('click', () => new InputModal(this.app, 'Rename scene preset', 'Preset name', async (v) => {
        if (!v.trim()) return; pr.name = v.trim(); await p.saveNow(); this.render();
      }, pr.name).open());
      const del = ctl.createEl('button', { text: 'Delete' }); del.className = 'nws-btn sm';
      del.addEventListener('click', async () => { if (confirm('Delete preset "' + pr.name + '"?')) { await p.deleteScenePreset(pr.id); this.render(); } });
    });

    const foot = contentEl.createDiv(); foot.style.cssText = 'margin-top:14px;border-top:1px solid var(--background-modifier-border);padding-top:12px';
    const save = foot.createEl('button', { text: '+ Save current setup as preset' }); save.className = 'nws-btn pri';
    save.addEventListener('click', () => new InputModal(this.app, 'Save current setup', 'e.g. Rainy Night Draft', async (v) => {
      if (!v.trim()) return; await p.saveScenePreset(v); this.render();
    }).open());
  }
  onClose() { this.contentEl.empty(); }
}


module.exports = NovelWriterStudio;
