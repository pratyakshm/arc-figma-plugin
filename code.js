// ARC - Bend your type!
// Main thread (Figma sandbox). Reads the selected text node, draws a LIVE arc
// preview on the real Figma canvas (real font + fills), and on Apply commits it.
// 100% bend == full circle, 0% == straight line. The original layer is kept.
// Everything runs locally; no network access (see manifest networkAccess: none).

figma.showUI(__html__, { width: 1180, height: 720, themeColors: true });

// --- live-preview state ----------------------------------------------------
let previewGroup = null; // ephemeral arc group on canvas
let previewSource = null; // the text node currently hidden behind the preview
let building = false; // guards against reacting to our own canvas edits

// --- helpers ---------------------------------------------------------------

// Iterate a string by Unicode code point, yielding (char, utf16Index, utf16Len).
function eachChar(text, cb) {
  let i = 0;
  while (i < text.length) {
    const code = text.codePointAt(i);
    const len = code > 0xffff ? 2 : 1;
    cb(text.substr(i, len), i, len);
    i += len;
  }
}

function rgbToCss(c) {
  const to = (v) => Math.round(v * 255);
  return `rgb(${to(c.r)}, ${to(c.g)}, ${to(c.b)})`;
}

function selectedText() {
  return figma.currentPage.selection.find((n) => n.type === "TEXT") || null;
}

// Pull a previewable description of the current selection for the panel sketch.
function readSelection() {
  const node = previewSource && !previewSource.removed ? previewSource : selectedText();
  if (!node) return null;

  let fontFamily = "sans-serif";
  if (node.fontName !== figma.mixed) fontFamily = node.fontName.family;
  else if (node.characters.length) {
    const f = node.getRangeFontName(0, 1);
    if (f !== figma.mixed) fontFamily = f.family;
  }

  let fontSize = 32;
  if (typeof node.fontSize === "number") fontSize = node.fontSize;
  else if (node.characters.length) {
    const s = node.getRangeFontSize(0, 1);
    if (typeof s === "number") fontSize = s;
  }

  let color = "rgb(0, 0, 0)";
  const fills = node.fills;
  if (fills !== figma.mixed && fills.length) {
    const solid = fills.find((f) => f.type === "SOLID" && f.visible !== false);
    if (solid) color = rgbToCss(solid.color);
  }

  return { text: node.characters, fontFamily, fontSize, color };
}

function pushSelection() {
  figma.ui.postMessage({ type: "selection", payload: readSelection() });
}

async function loadNodeFonts(node) {
  const seen = new Set();
  const fonts = [];
  const add = (f) => {
    if (f === figma.mixed) return;
    const key = `${f.family}__${f.style}`;
    if (!seen.has(key)) {
      seen.add(key);
      fonts.push(f);
    }
  };
  if (node.fontName !== figma.mixed) add(node.fontName);
  else eachChar(node.characters, (_c, i, len) => add(node.getRangeFontName(i, i + len)));
  await Promise.all(fonts.map((f) => figma.loadFontAsync(f)));
  return fonts;
}

// --- the actual bend (builds a fresh group; does NOT touch the original) ----

async function buildArcGroup(node, bendPct) {
  const text = node.characters;
  if (!text.trim()) return null;
  const bend = Math.max(0, Math.min(100, bendPct)) / 100;
  if (bend < 0.01) return null;

  const fonts = await loadNodeFonts(node);
  const fallbackFill = [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }];
  const baseFills =
    node.fills === figma.mixed ? fallbackFill : JSON.parse(JSON.stringify(node.fills));

  const parent = figma.currentPage; // page coords avoid auto-layout interference

  // 1) Create + measure one node per code point (whitespace kept for spacing).
  const metrics = [];
  eachChar(text, (ch, i, len) => {
    const font =
      node.fontName === figma.mixed ? node.getRangeFontName(i, i + len) : node.fontName;
    let size = 32;
    if (typeof node.fontSize === "number") size = node.fontSize;
    else {
      const s = node.getRangeFontSize(i, i + len);
      if (typeof s === "number") size = s;
    }

    const t = figma.createText();
    parent.appendChild(t);
    t.fontName = font === figma.mixed ? fonts[0] : font;
    t.fontSize = size;
    t.characters = ch;
    t.fills = baseFills;

    const keep = ch.trim().length > 0;
    metrics.push({ t: keep ? t : null, w: t.width, h: t.height, keep });
    if (!keep) t.remove();
  });

  const total = metrics.reduce((s, m) => s + m.w, 0);
  const kept = metrics.filter((m) => m.keep);
  if (!kept.length || total <= 0) {
    kept.forEach((m) => m.t && m.t.remove());
    return null;
  }

  // 2) Lay glyphs along a circle. Φ = bend * 2π so 100% closes the loop.
  const phi = bend * 2 * Math.PI;
  const radius = total / phi;
  let cum = 0;
  for (const m of metrics) {
    const centerS = cum + m.w / 2;
    cum += m.w;
    if (!m.keep) continue;

    const a = (centerS / total - 0.5) * phi; // 0 == top of the arch
    const cx = radius * Math.sin(a);
    const cy = -radius * Math.cos(a);
    const c = Math.cos(a);
    const s = Math.sin(a);
    const ax = m.w / 2; // anchor = glyph centre
    const ay = m.h / 2;
    m.t.relativeTransform = [
      [c, -s, cx - (c * ax - s * ay)],
      [s, c, cy - (s * ax + c * ay)],
    ];
  }

  // 3) Group and recentre on the original layer (absolute/page coords).
  const group = figma.group(kept.map((m) => m.t), parent);
  group.name = "Arc preview";
  const abb = node.absoluteBoundingBox;
  if (abb) {
    group.x += abb.x + abb.width / 2 - (group.x + group.width / 2);
    group.y += abb.y + abb.height / 2 - (group.y + group.height / 2);
  }
  return group;
}

// --- live preview lifecycle ------------------------------------------------

function clearPreview() {
  if (previewGroup && !previewGroup.removed) previewGroup.remove();
  previewGroup = null;
  if (previewSource && !previewSource.removed) previewSource.visible = true;
  previewSource = null;
}

async function refreshPreview(bendPct) {
  building = true;
  try {
    clearPreview();
    const node = selectedText();
    if (!node || bendPct < 1) return; // bend 0 == the original itself, no group
    const group = await buildArcGroup(node, bendPct);
    if (!group) return;
    node.visible = false; // hide straight original behind the arc
    previewSource = node;
    previewGroup = group;
  } finally {
    building = false;
  }
}

// --- commit ----------------------------------------------------------------

async function applyArc(bendPct) {
  if (!selectedText() && !(previewSource && !previewSource.removed)) {
    figma.notify("Select a text layer first");
    return;
  }
  if (bendPct < 1) {
    figma.notify("Set bend above 0% to arc the text");
    return;
  }

  await refreshPreview(bendPct);
  if (!previewGroup) {
    figma.notify("Nothing to bend");
    return;
  }

  // Keep the original layer, finalise the preview group as the result.
  if (previewSource && !previewSource.removed) previewSource.visible = true;
  const group = previewGroup;
  const src = previewSource;
  previewGroup = null;
  previewSource = null;
  group.name = src ? `Arc: ${src.characters.slice(0, 24)}` : "Arc";

  figma.currentPage.selection = [group]; // triggers selectionchange -> UI updates
  figma.notify("Bent! ✨  (original kept; ⌘Z to undo)");
}

// --- wiring ----------------------------------------------------------------

figma.on("selectionchange", () => {
  if (building) return;
  clearPreview();
  pushSelection();
});

try {
  figma.on("close", () => clearPreview());
} catch (e) {
  /* older API without a close event — cleaned up on next selection instead */
}

pushSelection();

figma.ui.onmessage = async (msg) => {
  try {
    if (msg.type === "preview") {
      await refreshPreview(msg.bend);
    } else if (msg.type === "apply") {
      await applyArc(msg.bend);
    } else if (msg.type === "request-selection") {
      pushSelection();
    } else if (msg.type === "close") {
      clearPreview();
      figma.closePlugin();
    }
  } catch (e) {
    figma.notify("Couldn't do that: " + e.message);
  }
};
