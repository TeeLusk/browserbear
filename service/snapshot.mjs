// Turns Chrome's accessibility tree into a short list an agent can act on:
//
//   # Channel content
//   e4 button "Upload videos"
//   e7 textbox "Title" = "My video"
//   e9 checkbox "Made for kids" [checked]
//   e11 file-input #video-file accept="video/*" [hidden]
//
// Only headings (for orientation) and things you can interact with make the
// cut; a full tree runs 14-19k tokens on real sites, this is usually under 1k.
// Refs (e4) stick to the same DOM node for as long as the service runs, so a
// diff between two snapshots reads as "what changed", not a renumbering.

const INTERACTIVE = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch',
  'slider', 'spinbutton', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab',
  'option', 'treeitem', 'listbox',
]);
// Containers worth naming because they change what's clickable (a dialog
// covering the page, an alert that just appeared).
const LANDMARKS = new Set(['dialog', 'alertdialog', 'alert']);
const FLAGS = ['disabled', 'checked', 'pressed', 'selected', 'expanded', 'focused', 'required', 'invalid'];
// Not plain "pass": that masked every "passport" field on GOV.UK (30 Oct).
const SECRET_NAME = /pass(word|code|phrase)|\bpass\b|secret|token|api.?key|cvc|cvv|card.?number|one.?time|otp/i;
const MAX_NAME = 80;

// Per-tab ref memory: backendDOMNodeId -> "eN". A node in a frame from another
// site lives in that frame's own debugger session, where backend ids start again,
// so it's keyed by the frame too and stands in as a negative id: service.mjs's
// cdp() turns that back into the frame's session and its real id.
export class RefMap {
  constructor() {
    this.byNode = new Map();
    this.byRef = new Map();
    this.inFrame = new Map(); // negative id -> { frame, id }
    this.next = 1;
  }
  ref(backendId, frame = null) {
    const key = frame ? `${frame}:${backendId}` : backendId;
    let r = this.byNode.get(key);
    if (!r) {
      r = `e${this.next++}`;
      this.byNode.set(key, r);
      let id = backendId;
      if (frame) {
        id = -(this.inFrame.size + 1);
        this.inFrame.set(id, { frame, id: backendId });
      }
      this.byRef.set(r, id);
    }
    return r;
  }
  node(ref) {
    return this.byRef.get(ref);
  }
  // For a negative id: which frame (its target id) and its id there.
  where(id) {
    return id < 0 ? this.inFrame.get(id) : null;
  }
}

const clip = (s) => {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > MAX_NAME ? s.slice(0, MAX_NAME - 1) + '…' : s;
};

const propValue = (node, name) => node.properties?.find((p) => p.name === name)?.value?.value;

// File inputs come from the DOM (service.mjs's fileInputs), not the
// accessibility tree: sites hide the real one behind a styled "Choose files"
// button, and a hidden element isn't in the tree at all. Without them listed,
// an agent has nothing to pass to upload (Adobe Podcast Enhance, 30 Oct).
function fileInputLine(ref, f, axName, hidden) {
  let text = `${ref} file-input`;
  const name = axName || clip(f.label);
  if (name) text += ` "${name}"`;
  if (f.id) text += ` #${f.id}`;
  if (f.accept) text += ` accept="${clip(f.accept)}"`;
  const flags = [f.multiple && 'multiple', f.disabled && 'disabled', hidden && 'hidden'].filter(Boolean);
  if (flags.length) text += ` [${flags.join(', ')}]`;
  return text;
}

// fileInputs: backendDOMNodeId -> { id, label, accept, multiple, disabled }
// frame: the target id of the frame from another site these nodes are in, if
// they are. frames: an iframe element's backendDOMNodeId -> its content's lines
// ({ label, lines }), put in where the iframe is, indented under it.
export function compact(axNodes, refs, fileInputs = new Map(), masked = new Set(), { frame = null, frames = new Map() } = {}) {
  const byId = new Map(axNodes.map((n) => [n.nodeId, n]));
  const root = axNodes.find((n) => !n.parentId) || axNodes[0];
  const lines = [];
  const seen = new Set();
  const shown = new Set(); // file inputs the tree already had

  // An iframe's content goes right after it, indented. A frame left out of the
  // tree (aria-hidden) is left out here too.
  const put = (owner) => {
    const inner = frames.get(owner);
    if (!inner.lines.length) return;
    lines.push(`[frame ${inner.label}]`);
    for (const l of inner.lines) lines.push(`  ${l}`);
  };
  const walk = (node) => {
    if (!node || seen.has(node.nodeId)) return;
    seen.add(node.nodeId);
    const role = node.role?.value;
    const name = clip(node.name?.value);
    if (!node.ignored) {
      if (fileInputs.has(node.backendDOMNodeId)) {
        shown.add(node.backendDOMNodeId);
        lines.push(fileInputLine(refs.ref(node.backendDOMNodeId, frame), fileInputs.get(node.backendDOMNodeId), name, false));
      } else if (role === 'heading' && name) {
        lines.push(`${'#'.repeat(Math.min(Number(propValue(node, 'level')) || 2, 6))} ${name}`);
      } else if (LANDMARKS.has(role)) {
        lines.push(`[${role}${name ? ` "${name}"` : ''}]`);
      } else if (INTERACTIVE.has(role) && node.backendDOMNodeId) {
        let text = `${refs.ref(node.backendDOMNodeId, frame)} ${role}`;
        if (name) text += ` "${name}"`;
        const value = node.value?.value;
        if (value !== undefined && value !== '' && value !== name) {
          text += SECRET_NAME.test(name) || masked.has(node.backendDOMNodeId) ? ' = "••••"' : ` = "${clip(value)}"`;
        }
        const flags = FLAGS.filter((f) => {
          const v = propValue(node, f);
          return v === true || v === 'true' || v === 'mixed';
        });
        if (flags.length) text += ` [${flags.join(', ')}]`;
        lines.push(text);
      }
    }
    if (frames.has(node.backendDOMNodeId)) put(node.backendDOMNodeId);
    for (const id of node.childIds || []) walk(byId.get(id));
  };
  walk(root);
  // The rest aren't in the tree, so they're hidden; they go at the end.
  for (const [id, f] of fileInputs) if (!shown.has(id)) lines.push(fileInputLine(refs.ref(id, frame), f, '', true));
  return lines;
}

// Returns the cheaper of a diff against the last snapshot and the full list.
export function diff(before, after) {
  if (!before) return { full: true, text: after.join('\n') };
  const was = new Set(before);
  const now = new Set(after);
  const added = after.filter((l) => !was.has(l));
  const removed = before.filter((l) => !now.has(l));
  if (!added.length && !removed.length) return { full: false, text: '(no change)' };
  const text = [...removed.map((l) => `- ${l}`), ...added.map((l) => `+ ${l}`)].join('\n');
  // A navigation changes nearly everything; then the plain list is shorter.
  if (text.length >= after.join('\n').length) return { full: true, text: after.join('\n') };
  return { full: false, text: `${text}\n(${after.length - added.length} unchanged)` };
}

// Whether two snapshots differ only in what has focus. A click focuses what it
// lands on, so a click the page ignored still changes that much.
export function sameApartFromFocus(before, after) {
  if (!before || before.length !== after.length) return false;
  const unfocus = (l) => l.replace(/ \[([^\]]*)\]$/, (_, f) => {
    const rest = f.split(', ').filter((x) => x !== 'focused');
    return rest.length ? ` [${rest.join(', ')}]` : '';
  });
  return before.every((l, i) => unfocus(l) === unfocus(after[i]));
}
