// LINK PREVIEWS FOR THE GAME'S LINKS (2026-10-28).
//
// A track or a championship shared from the game (the header's share button)
// is https://spinoghostracing.com/t/<uuid> or /c/<uuid>. Those addresses fell
// to 404.html, which answers with HTTP 404 and no preview tags, so X, Discord
// and the rest showed a bare line of text. This writes, for every published
// track and every championship on the feed, a page at that address with the
// preview tags and a 1200 x 630 picture of the circuit as the race draws it:
// t/<uuid>/index.html + og.png, c/<uuid>/index.html + og.png.
//
//   node tools/og/build.mjs                    live: the game's own public feed
//   node tools/og/build.mjs --fixture f.json --levels dir --out /tmp/x
//                                             from files, elsewhere
//
// The live run reads SGR_SUPABASE_URL and SGR_SUPABASE_ANON_KEY — the same
// public coordinates the game ships with; the anon key reads only what any
// player's phone reads (the feed and cups RPCs, and a track's level file,
// which any phone downloads to race it). A page whose inputs have not
// changed is left as it is (its hash rides in a meta tag), so a run with
// nothing new writes nothing and downloads no level. Pages for tracks and
// cups that have left the feed — taken down, hidden, a cup a day past its
// end — are removed, but a run that would remove more than half of them
// stops instead: an empty or broken answer must not wipe the site.
//
// THE TRACK'S OWN ROAD AND WALLS (2026-10-29, user: "the images of deeplinks
// do not use correct surface, a bit bg and wall type"). The picture was every
// track in tarmac with red and white kerbs. It is now painted from the
// track's level file the way the race paints it: each stretch of road in its
// own material, each wall in its own recipe, bridges over what they cross
// with their shadows. The backdrop is one for every track — the first
// picture's black, its glow in a neutral grey (user, after trying each
// track's own ground behind it: "i wanted this to be same for everywhere",
// then "not lets use the green glow" and "with glow"). The colours and
// recipes come from looks.json, which the game writes from its own tables
// (godot/tools/export_og_looks.gd; the game's check_og_looks fails while this
// copy is stale). A change to the table redraws every picture, as a
// RENDER_VERSION bump does.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import opentype from "opentype.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(HERE, "../..");
const HOST = "https://spinoghostracing.com";
// Bump to draw every picture again (a change of style). 2: no "Free on
// Android and iPhone" — the site's copy rules allow no platform or price
// line (user, 2026-09-25; the game sells boards and colours). 3: each
// track's own ground, road and walls (a run downloads every level once).
// 4: one backdrop for every track again, the circuit back in its own room.
const RENDER_VERSION = "4";
// World units per metre, as the game counts a track's length (hero_overlay.gd).
const PER_METRE = 9.3;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const W = 1200;
const H = 630;

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const OUT = path.resolve(opt("--out") || SITE);
const FIXTURE = opt("--fixture");
// A folder of level files named as the game saves a downloaded track
// (pub_<uuid, hyphens as underscores>.json, plain or SGRZ1-gzipped), read
// instead of the server's — the game's own levels folder, for a test run.
const LEVELS = opt("--levels");
const FORCE = args.includes("--force");

const font = {
  name: opentype.loadSync(path.join(HERE, "fonts/BarlowCondensed-BlackItalic.ttf")),
  facts: opentype.loadSync(path.join(HERE, "fonts/BarlowCondensed-SemiBold.ttf")),
  label: opentype.loadSync(path.join(HERE, "fonts/Barlow-SemiBold.ttf")),
  small: opentype.loadSync(path.join(HERE, "fonts/Barlow-Regular.ttf")),
};

// ------------------------------------------------------------------ the data

async function rpc(fn, body) {
  const url = process.env.SGR_SUPABASE_URL;
  const key = process.env.SGR_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("SGR_SUPABASE_URL and SGR_SUPABASE_ANON_KEY are needed for a live run");
  const r = await fetch(`${url.replace(/\/$/, "")}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${fn}: HTTP ${r.status} ${await r.text()}`);
  const rows = await r.json();
  if (!Array.isArray(rows)) throw new Error(`${fn}: not a list`);
  return rows;
}

async function liveData() {
  const tracks = [];
  // The feed answers at least 100 rows a page (supabase_schema.sql, feed()).
  for (let offset = 0; offset < 10000;) {
    const rows = await rpc("feed", { p_limit: 100, p_offset: offset, p_sort: "new" });
    tracks.push(...rows);
    if (rows.length < 100) break;
    offset += rows.length;
  }
  const cups = await rpc("cups", { p_limit: 500 });
  return { tracks, cups };
}

// The flat outline the feed carries ([x0, y0, x1, y1, ...], world units) as
// points; [] for anything that is not a drawable loop.
function points(flat) {
  if (!Array.isArray(flat)) return [];
  const out = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const x = Number(flat[i]);
    const y = Number(flat[i + 1]);
    if (Number.isFinite(x) && Number.isFinite(y)) out.push([x, y]);
  }
  return out.length >= 3 ? out : [];
}

function lengthKm(pts) {
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    sum += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return sum / PER_METRE / 1000;
}

// A failure worth another try on the next run: the network, the server.
class Retry extends Error {}

// A track's level, as a phone downloads it to race the track: the public
// "tracks" bucket, pub/<uuid>.json (backend/functions/publish). A missing or
// broken file is an Error (the picture falls back to the feed's outline);
// the network or the server failing is a Retry.
async function levelText(key) {
  const id = key.slice(4);
  if (LEVELS) {
    const file = path.join(LEVELS, `pub_${id.replaceAll("-", "_")}.json`);
    if (!fs.existsSync(file)) throw new Error(`no ${path.basename(file)} in ${LEVELS}`);
    const raw = fs.readFileSync(file);
    const magic = Buffer.from("SGRZ1\n");
    return raw.subarray(0, magic.length).equals(magic)
      ? zlib.gunzipSync(raw.subarray(magic.length)).toString("utf8")
      : raw.toString("utf8");
  }
  if (FIXTURE) throw new Error("a fixture run reads levels only from --levels");
  const url = `${process.env.SGR_SUPABASE_URL.replace(/\/$/, "")}/storage/v1/object/public/tracks/pub/${id}.json`;
  let r;
  try {
    r = await fetch(url);
  } catch (e) {
    throw new Retry(`level ${id}: ${e.message}`);
  }
  // Storage answers a missing object with 400 as often as with 404.
  if (r.status === 400 || r.status === 404) throw new Error(`level ${id}: HTTP ${r.status}`);
  if (!r.ok) throw new Retry(`level ${id}: HTTP ${r.status}`);
  return await r.text();
}

const ONE = 2 ** 32;

function clampId(v, count) {
  return Math.min(count - 1, Math.max(0, Math.trunc(Number.isFinite(v) ? v : 0)));
}

// THE BAKED ROAD, as the race builds it (level.gd to_world; the waypoints are
// the editor's and the race never reads them). Per edge, ten numbers a
// sample — position x, y, height, distance along, tangent x, y, width left,
// width right (Q32.32 bits, written as text), surface id, border id
// (rust/gdext lib.rs add_edge). A closed edge ends on its first sample again.
function parseLevel(text) {
  const level = JSON.parse(text);
  const edges = [];
  for (const raw of Array.isArray(level.samples) ? level.samples : []) {
    if (!Array.isArray(raw)) continue;
    const pts = [];
    for (let o = 0; o + 9 < raw.length; o += 10) {
      const v = (k) => Number(raw[o + k]);
      const p = {
        x: v(0) / ONE, y: v(1) / ONE, z: v(2) / ONE, s: v(3) / ONE,
        tx: v(4) / ONE, ty: v(5) / ONE, wl: v(6) / ONE, wr: v(7) / ONE,
        surface: clampId(v(8), LOOKS.surfaces.length),
        border: clampId(v(9), LOOKS.borders.length),
      };
      if (![p.x, p.y, p.z, p.s, p.tx, p.ty, p.wl, p.wr].every(Number.isFinite)) throw new Error("a sample is not numbers");
      pts.push(p);
    }
    if (pts.length >= 2) edges.push(pts);
  }
  if (!edges.length) throw new Error("the level has no road");
  const start = Math.min(edges[0].length - 1, Math.max(0, Math.trunc(Number(level.start_sample) || 0)));
  return { edges, start };
}

// The feed's outline as a road in the game's defaults — asphalt between red
// and white kerbs (level.gd DEFAULT_*) — for a track whose level cannot be
// read: a plainer picture, never none.
function outlineLook(pts) {
  const n = pts.length;
  const edge = [];
  let s = 0;
  for (let i = 0; i <= n; i++) {
    const a = pts[i % n];
    const prev = pts[(i - 1 + n) % n];
    const next = pts[(i + 1) % n];
    if (i > 0) s += Math.hypot(a[0] - prev[0], a[1] - prev[1]);
    const dx = next[0] - prev[0];
    const dy = next[1] - prev[1];
    const len = Math.hypot(dx, dy) || 1;
    edge.push({
      x: a[0], y: a[1], z: 0, s, tx: dx / len, ty: dy / len, wl: 150, wr: 150,
      surface: Math.max(0, LOOKS.surfaces.findIndex((x) => x.name === "asphalt_new")),
      border: Math.max(0, LOOKS.borders.findIndex((x) => x.name === "curb_red")),
    });
  }
  return { edges: [edge], start: 0 };
}

// ----------------------------------------------------------------- the words

// A player's name drawn in the game's face: characters the face has no glyph
// for (emoji, a warning sign) are left out rather than drawn as boxes.
function drawable(f, text) {
  let out = "";
  for (const ch of String(text || "")) {
    if (ch === " " || f.charToGlyphIndex(ch) > 0) out += ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

function textPath(f, text, x, y, size, fill) {
  const d = f.getPath(text, x, y, size).toPathData(2);
  return d ? `<path d="${d}" fill="${fill}"/>` : "";
}

function width(f, text, size) {
  return f.getAdvanceWidth(text, size);
}

// The name as big as it fits: one line if it can stand at a readable size,
// else two lines split where the halves come out most even.
function nameLines(text, maxW, maxSize, minOne) {
  const one = Math.min(maxSize, (maxW / Math.max(1, width(font.name, text, 1))) * 0.98);
  if (one >= minOne || !text.includes(" ")) return { lines: [text], size: Math.max(28, Math.min(one, maxSize)) };
  const words = text.split(" ");
  let best = null;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(" ");
    const b = words.slice(i).join(" ");
    const wide = Math.max(width(font.name, a, 1), width(font.name, b, 1));
    if (!best || wide < best.wide) best = { a, b, wide };
  }
  const size = Math.max(28, Math.min(maxSize * 0.86, (maxW / best.wide) * 0.98));
  return { lines: [best.a, best.b], size };
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// ----------------------------------------------------------------- the picture

const LOGO = (() => {
  const svg = fs.readFileSync(path.join(SITE, "assets/spino.svg"), "utf8");
  const viewBox = (svg.match(/viewBox="([^"]+)"/) || [])[1] || "0 0 100 100";
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  return { viewBox, inner };
})();

// The game's look table, surfaces and borders by id — and its hash, which
// every page's hash carries.
const LOOKS_TEXT = fs.readFileSync(path.join(HERE, "looks.json"), "utf8");
const LOOKS = JSON.parse(LOOKS_TEXT);
const LOOKS_HASH = crypto.createHash("sha256").update(LOOKS_TEXT).digest("hex");

// What the Rust renderer keeps to itself (rust/gdext/src/lib.rs), as numbers.
const SHADE_STEP = 24; // BORDER_SHADE_STEP: height per shade step, walls and road
const ROAD_SHADE_HEIGHT = 160; // a raised road is lifted toward white by
const ROAD_SHADE_LIFT = 0.15; //   up to this much at this height
const CLEARANCE = 120; // ghost_sim::consts::BRIDGE_CLEARANCE
const LAYER_CELL = 256;
// A WALL YOU CAN SEE. A whole circuit in a picture is a few hundredths of a
// pixel per world unit: a 28-unit kerb is a pixel, its 40-unit blocks are
// not there at all, and the race's own overview of a circuit shows a road
// with no walls. So walls — and the finish line — are drawn up to this many
// pixels across, every layer and dash of a recipe grown alike, but never
// wider than this share of the road beside them: on a thirty-kilometre
// track the road is five pixels, and kerbs at four a side were all there was
// to see. The road keeps its true width, and a kerb its true reach onto it.
const WALL_PX = 4;
const WALL_SHARE = 0.4;
const KERB_BAND = 28; // a kerb's band, twice its run-off (barriers.gd)
// A tiny circuit is not blown up past this many pixels per world unit: a
// loop a few car lengths round stays a loop, not a blot of tarmac filling
// the picture.
const MOST_SCALE = 0.35;

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// `hex` taken toward white by `t` (0..1).
function lift(hex, t) {
  if (t <= 0) return hex;
  return "#" + rgb(hex).map((c) => Math.round(c + (255 - c) * t).toString(16).padStart(2, "0")).join("");
}

const f1 = (v) => (Math.round(v * 10) / 10).toString();

// Every segment of every edge: a sample and the next.
function segmentsOf(look) {
  const segs = [];
  look.edges.forEach((e, edge) => {
    for (let i = 0; i + 1 < e.length; i++) segs.push({ edge, i, a: e[i], b: e[i + 1] });
  });
  return segs;
}

const halfOf = (sg) => Math.max(sg.a.wl, sg.a.wr, sg.b.wl, sg.b.wr);

// Squared distance from `p` to a segment's ribbon (track.rs distance_sq_to_ribbon).
function ribbonDist2(sg, p) {
  const dx = sg.b.x - sg.a.x;
  const dy = sg.b.y - sg.a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return (p.x - sg.a.x) ** 2 + (p.y - sg.a.y) ** 2;
  const rx = p.x - sg.a.x;
  const ry = p.y - sg.a.y;
  const along = (rx * dx + ry * dy) / len;
  const across = Math.abs((dx * ry - dy * rx) / len);
  const over = along < 0 ? -along : along > len ? along - len : 0;
  const out = Math.max(0, across - halfOf(sg));
  return over * over + out * out;
}

// DRAW LAYERS FROM OVERLAPS (lib.rs assign_layers): a segment a clearance
// above a road it lies over draws a layer above that road. The rest — all
// of a flat track — is layer zero. `under[k]` says the segment is over
// another road outright, which is where a deck casts its shadow.
function layersOf(look, segs) {
  const layers = new Array(segs.length).fill(0);
  const under = new Array(segs.length).fill(false);
  let floor = Infinity;
  let top = -Infinity;
  for (const e of look.edges) {
    for (const p of e) {
      floor = Math.min(floor, p.z);
      top = Math.max(top, p.z);
    }
  }
  if (top - floor < CLEARANCE) return { layers, under, floor };
  const totals = look.edges.map((e) => e[e.length - 1].s);
  const ceiling = top - CLEARANCE;
  const grid = new Map();
  segs.forEach((sg, k) => {
    if (sg.a.z > ceiling) return;
    const pad = halfOf(sg) + 1;
    const x0 = Math.floor((Math.min(sg.a.x, sg.b.x) - pad) / LAYER_CELL);
    const x1 = Math.floor((Math.max(sg.a.x, sg.b.x) + pad) / LAYER_CELL);
    const y0 = Math.floor((Math.min(sg.a.y, sg.b.y) - pad) / LAYER_CELL);
    const y1 = Math.floor((Math.max(sg.a.y, sg.b.y) + pad) / LAYER_CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const key = `${cx},${cy}`;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(k);
      }
    }
  });
  const order = segs.map((_, k) => k).sort((p, q) => segs[p].a.z - segs[q].a.z || p - q);
  const seen = new Int32Array(segs.length).fill(-1);
  for (const k of order) {
    const sg = segs[k];
    if (sg.a.z - floor < CLEARANCE) continue;
    const mid = { x: (sg.a.x + sg.b.x) / 2, y: (sg.a.y + sg.b.y) / 2 };
    const half = halfOf(sg);
    const limit = sg.a.z - CLEARANCE;
    let lowest = 0;
    const x0 = Math.floor((mid.x - half - 1) / LAYER_CELL);
    const x1 = Math.floor((mid.x + half + 1) / LAYER_CELL);
    const y0 = Math.floor((mid.y - half - 1) / LAYER_CELL);
    const y1 = Math.floor((mid.y + half + 1) / LAYER_CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        for (const o of grid.get(`${cx},${cy}`) || []) {
          if (seen[o] === k) continue;
          seen[o] = k;
          const other = segs[o];
          if (other.a.z > limit) continue;
          // A ROAD IS NOT OVER ITS OWN RECENT PAST: a ramp is a clearance
          // above the road just behind it. Only a genuine return counts.
          if (other.edge === sg.edge) {
            let arc = Math.abs(sg.a.s - other.a.s);
            const total = totals[sg.edge];
            if (total > 0 && total - arc < arc) arc = total - arc;
            if (arc < half * 4 + CLEARANCE * 8) continue;
          }
          const d2 = ribbonDist2(other, mid);
          if (d2 > half * half) continue;
          if (d2 === 0) under[k] = true;
          lowest = Math.max(lowest, layers[o] + 1);
        }
      }
    }
    layers[k] = lowest;
  }
  return { layers, under, floor };
}

// The polyline pushed `by` along its left-hand normal (barriers.gd outward).
function outward(pts, by) {
  if (by === 0) return pts;
  const n = pts.length;
  return pts.map((p, i) => {
    const a = pts[Math.max(i - 1, 0)];
    const b = pts[Math.min(i + 1, n - 1)];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    return len < 1e-6 ? p : { x: p.x - (dy / len) * by, y: p.y + (dx / len) * by };
  });
}

// Where the circuit sits in `box`: the scale (pixels per world unit), the
// walls' growth, and the world's origin on the picture, centred.
function framing(look, box) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let half = 0;
  const widths = [];
  for (const e of look.edges) {
    for (const p of e) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
      half = Math.max(half, p.wl, p.wr);
      widths.push(p.wl + p.wr);
    }
  }
  widths.sort((a, b) => a - b);
  const road = widths[widths.length >> 1];
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const grow = (s) => Math.max(1, Math.min(WALL_PX, road * s * WALL_SHARE) / (KERB_BAND * s));
  let s = Math.min(box.w / Math.max(1, spanX + half * 2), box.h / Math.max(1, spanY + half * 2), MOST_SCALE);
  for (let i = 0; i < 3; i++) {
    // Room for the widest wall (a tyre wall, 36) grown, and a shadow.
    const pad = half + 40 * grow(s) + 4 / s;
    s = Math.min(box.w / Math.max(1, spanX + pad * 2), box.h / Math.max(1, spanY + pad * 2), MOST_SCALE);
  }
  return {
    s,
    grow: grow(s),
    ox: box.x + (box.w - spanX * s) / 2 - minX * s,
    oy: box.y + (box.h - spanY * s) / 2 - minY * s,
  };
}

// THE CIRCUIT AS THE RACE DRAWS IT (track_view.gd), layer by layer from the
// ground up: a deck's shadow, the road in each stretch's own material, the
// walls in each stretch's own recipe — and on the ground layer, the finish.
function circuit(look, frame) {
  const { s, grow, ox, oy } = frame;
  const X = (p) => f1(ox + p.x * s);
  const Y = (p) => f1(oy + p.y * s);
  const segs = segmentsOf(look);
  const { layers, under, floor } = layersOf(look, segs);
  const segAt = [];
  let k = 0;
  look.edges.forEach((e, edge) => {
    segAt[edge] = [];
    for (let i = 0; i + 1 < e.length; i++) segAt[edge][i] = k++;
  });
  const top = layers.reduce((m, l) => Math.max(m, l), 0);
  const edgeOf = (p, side) => {
    const nx = -p.ty;
    const ny = p.tx;
    return side > 0 ? { x: p.x + nx * p.wl, y: p.y + ny * p.wl } : { x: p.x - nx * p.wr, y: p.y - ny * p.wr };
  };

  // SHADOWS (track_shadow_mesh): the segments over another road outright,
  // grown along the deck while it stays raised, thrown sideways toward the
  // light by their height.
  const shadowed = under.slice();
  under.forEach((u, idx) => {
    if (!u) return;
    for (const dir of [-1, 1]) {
      for (let n = idx + dir; n >= 0 && n < segs.length; n += dir) {
        if (segs[n].edge !== segs[idx].edge || layers[n] <= 0) break;
        shadowed[n] = true;
      }
    }
  });
  const light = LOOKS.shadow.direction;
  const thrown = (p, side) => {
    const e = edgeOf(p, side);
    let nx = -p.ty;
    let ny = p.tx;
    if (nx * light[0] + ny * light[1] < 0) {
      nx = -nx;
      ny = -ny;
    }
    const by = Math.max(0, p.z - floor) * LOOKS.shadow.per_unit;
    return { x: e.x + nx * by, y: e.y + ny * by };
  };

  const shadows = new Map(); // layer -> path
  const roads = new Map(); // layer -> Map(colour -> path)
  let footprint = ""; // every quad, for the circuit's drop shadow
  segs.forEach((sg, idx) => {
    const layer = layers[idx];
    if (shadowed[idx]) {
      const q = [thrown(sg.a, 1), thrown(sg.b, 1), thrown(sg.b, -1), thrown(sg.a, -1)];
      shadows.set(layer, (shadows.get(layer) || "") + `M${q.map((p) => `${X(p)} ${Y(p)}`).join("L")}Z`);
    }
    // The height tint, in the race's steps (track_mesh_by_surface).
    const step = Math.max(0, Math.floor(sg.a.z / SHADE_STEP));
    const t = Math.min(1, (step * SHADE_STEP) / ROAD_SHADE_HEIGHT) * ROAD_SHADE_LIFT;
    const colour = lift(LOOKS.surfaces[sg.a.surface].far, t);
    const q = [edgeOf(sg.a, 1), edgeOf(sg.b, 1), edgeOf(sg.b, -1), edgeOf(sg.a, -1)];
    if (!roads.has(layer)) roads.set(layer, new Map());
    const byColour = roads.get(layer);
    const quad = `M${q.map((p) => `${X(p)} ${Y(p)}`).join("L")}Z`;
    byColour.set(colour, (byColour.get(colour) || "") + quad);
    footprint += quad;
  });

  // WALLS (track_borders + barriers.gd): each side cut into runs of one
  // border, one layer and one height step; a run takes the next one's first
  // point so the two meet. A wall stands outside the road's edge, a kerb
  // across it; a raised run is lit toward white.
  const walls = new Map(); // layer -> svg
  look.edges.forEach((e, edge) => {
    const style = e.map((p, i) => {
      const seg = segAt[edge][Math.min(i, e.length - 2)];
      return [p.border, layers[seg], Math.floor(p.z / SHADE_STEP)];
    });
    const same = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
    for (const side of [1, -1]) {
      // ONE PATTERN DOWN THE WHOLE SIDE. The race starts a run's dashes
      // afresh, which a 40-unit kerb block hides; grown for the picture, a
      // block outlasts the runs a ramp is cut into (one per height step),
      // and every run showed only its first block: a smear of solid red.
      // So each run picks the pattern up where the side has got to.
      const along = [0];
      for (let j = 1; j < e.length; j++) {
        const a = edgeOf(e[j - 1], side);
        const b = edgeOf(e[j], side);
        along.push(along[j - 1] + Math.hypot(b.x - a.x, b.y - a.y));
      }
      let start = 0;
      for (let i = 1; i <= e.length; i++) {
        if (i < e.length && same(style[i], style[start])) continue;
        const end = Math.min(i, e.length - 1);
        if (end > start) {
          const border = LOOKS.borders[style[start][0]];
          const layer = style[start][1];
          let height = 0;
          for (let j = start; j <= end; j++) height += e[j].z;
          height /= end - start + 1;
          const widest = border.layers.reduce((m, l) => Math.max(m, l.width), 0);
          const reach = Math.max(0, border.run_off);
          const line = outward(e.slice(start, end + 1).map((p) => edgeOf(p, side)), side * ((widest * grow) / 2 - reach));
          const d = `M${line.map((p) => `${X(p)} ${Y(p)}`).join("L")}`;
          const lit = Math.min(1, Math.max(0, height / LOOKS.walls.shade_height)) * LOOKS.walls.shade_lift;
          let out = "";
          for (const l of border.layers) {
            const w = l.width * grow * s;
            const period = l.dash.length ? (l.dash[0] + l.dash[1]) * grow * s : 0;
            const dash = l.dash.length
              ? ` stroke-dasharray="${l.dash.map((v) => f1(Math.max(0.01, v * grow * s))).join(" ")}" stroke-dashoffset="${f1((along[start] * s) % period)}"`
              : "";
            const cap = l.round ? "round" : "butt";
            out += `<path d="${d}" fill="none" stroke="${lift(l.colour, lit)}"${l.alpha < 1 ? ` stroke-opacity="${l.alpha}"` : ""} stroke-width="${f1(w)}" stroke-linecap="${cap}" stroke-linejoin="round"${dash}/>`;
          }
          walls.set(layer, (walls.get(layer) || "") + out);
        }
        start = i;
      }
    }
  });

  // THE FINISH (main.gd _build_finish_line, finish_line.gd): two rows of
  // squares across the road at the start, grown like the walls.
  const at = look.edges[0][look.start];
  const next = look.edges[0][Math.min(look.start + 4, look.edges[0].length - 1)];
  let finish = "";
  {
    const a = edgeOf(at, 1);
    const b = edgeOf(at, -1);
    const across = { x: b.x - a.x, y: b.y - a.y };
    const width = Math.hypot(across.x, across.y);
    if (width > 1) {
      across.x /= width;
      across.y /= width;
      let along = { x: next.x - at.x, y: next.y - at.y };
      const len = Math.hypot(along.x, along.y) || 1;
      along = { x: along.x / len, y: along.y / len };
      const depth = Math.min(36, Math.max(18, Math.min(at.wl, at.wr) * 0.5)) * grow;
      const cell = depth / 2;
      const cols = Math.max(4, Math.round(width / cell));
      const cw = width / cols;
      const origin = { x: a.x - along.x * depth * 0.5, y: a.y - along.y * depth * 0.5 };
      for (let r = 0; r < 2; r++) {
        for (let c = 0; c < cols; c++) {
          const p = { x: origin.x + across.x * c * cw + along.x * r * cell, y: origin.y + across.y * c * cw + along.y * r * cell };
          const q = [p, { x: p.x + across.x * cw, y: p.y + across.y * cw },
            { x: p.x + across.x * cw + along.x * cell, y: p.y + across.y * cw + along.y * cell },
            { x: p.x + along.x * cell, y: p.y + along.y * cell }];
          finish += `<path d="M${q.map((v) => `${X(v)} ${Y(v)}`).join("L")}Z" fill="${(r + c) % 2 === 0 ? "#f2f2f2" : "#0f0f0f"}"/>`;
        }
      }
    }
  }

  // THE CIRCUIT LIFTED OFF THE BACKDROP, as the first of these pictures
  // had it: its footprint, walls and all, in soft black a little below it.
  let svg = `<g opacity="0.5" filter="url(#soft)" transform="translate(0 7)"><path d="${footprint}" fill="#000" stroke="#000" stroke-width="${f1(72 * grow * s + 6)}" stroke-linejoin="round"/></g>`;
  for (let layer = 0; layer <= top; layer++) {
    if (shadows.has(layer)) svg += `<path d="${shadows.get(layer)}" fill="#000" fill-opacity="${LOOKS.shadow.alpha.toFixed(2)}"/>`;
    // Each stretch's quads in one path, edged in their own colour: two
    // paths meeting edge to edge leave a hairline of backdrop between them
    // where the race's mesh has none.
    for (const [colour, d] of roads.get(layer) || []) {
      svg += `<path d="${d}" fill="${colour}" stroke="${colour}" stroke-width="0.6" stroke-linejoin="round"/>`;
    }
    svg += walls.get(layer) || "";
    if (layer === 0) svg += finish;
  }
  return svg;
}

function picture({ kind, name, facts, by, look }) {
  const left = 64;
  const textW = 470;
  // THE FIRST PICTURE'S LOOK (user: "direction", over a photo of it; "i
  // wanted this to be same for everywhere"): one backdrop for every track —
  // a dark diagonal and a soft glow, grey rather than the first one's green
  // ("not lets use the green glow", "with glow") — and the circuit in its
  // own room on the right, clear of the words. Only the circuit is the
  // track's own.
  const art = { x: 580, y: 36, w: 580, h: 558 };
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0f1015"/><stop offset="1" stop-color="#171b24"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#2a2d36" stop-opacity="0.9"/><stop offset="1" stop-color="#2a2d36" stop-opacity="0"/>
    </radialGradient>
    <filter id="soft" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur stdDeviation="5"/></filter>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <ellipse cx="880" cy="315" rx="340" ry="300" fill="url(#glow)"/>`;
  // The circuit, or the house's dino where a cup has no published stage.
  if (look) {
    svg += circuit(look, framing(look, art));
  } else {
    svg += `<svg x="${art.x + 40}" y="${art.y + 110}" width="${art.w - 80}" height="${art.h - 220}" viewBox="${LOGO.viewBox}">${LOGO.inner}</svg>`;
  }
  // The wordmark, top left: the dino and SPINO GHOST RACING.
  svg += `<svg x="${left}" y="48" width="74" height="50" viewBox="${LOGO.viewBox}">${LOGO.inner}</svg>`;
  svg += textPath(font.name, "SPINO GHOST", left + 86, 88, 38, "#f4f4f5");
  svg += textPath(font.name, "RACING", left + 86 + width(font.name, "SPINO GHOST ", 38), 88, 38, "#ef4444");
  // What it is: a dark pill with a dot, as the game's band.
  const label = kind === "cup" ? "CHAMPIONSHIP" : "TRACK";
  const labelW = width(font.label, label, 22) + 58;
  const dot = kind === "cup" ? "#ef4444" : "#eab308";
  svg += `<rect x="${left}" y="168" width="${labelW.toFixed(1)}" height="40" rx="20" fill="#1b1e26"/>`;
  svg += `<circle cx="${left + 24}" cy="188" r="7" fill="${dot}"/>`;
  svg += textPath(font.label, label, left + 42, 196, 22, "#f4f4f5");
  // The name, as big as it fits — across, and down: the block of name, facts
  // and maker ends a gap above the footer. Per line of the name, its ascent
  // (0.8 of the size) and descent (0.2) make one size; the facts take 50 px
  // (gap, ascent, descent) and the maker 39.
  const nl = nameLines(name, textW, 104, 64);
  const n = nl.lines.length;
  const top = 236;
  const extras = (facts ? 50 : 0) + (by ? 39 : 0);
  nl.size = Math.min(nl.size, (556 - top - extras) / n);
  let y = top + nl.size * 0.8;
  nl.lines.forEach((line, i) => {
    svg += textPath(font.name, line, left, y, nl.size, "#ffffff");
    if (i < n - 1) y += nl.size;
  });
  y += nl.size * 0.2;
  // Both lines keep to the words' column: a long one is set smaller.
  const fit = (f, text, size) => Math.min(size, (size * textW) / Math.max(1, width(f, text, size)));
  if (facts) {
    y += 14 + 28;
    svg += textPath(font.facts, facts, left, y, fit(font.facts, facts, 38), "#cfd2dc");
    y += 8;
  }
  if (by) {
    y += 12 + 21;
    svg += textPath(font.label, by, left, y, fit(font.label, by, 28), "#eab308");
    y += 6;
  }
  svg += "</svg>";
  return svg;
}

function png(svg) {
  return new Resvg(svg, { fitTo: { mode: "width", value: W }, font: { loadSystemFonts: false } }).render().asPng();
}

// ------------------------------------------------------------------ the page

function page({ kind, id, title, description, alt, hash }) {
  const dir = kind === "cup" ? "c" : "t";
  const url = `${HOST}/${dir}/${id}`;
  const image = `${url}/og.png?v=${hash.slice(0, 10)}`;
  const what = kind === "cup" ? "A championship in Spino Ghost Racing" : "A track in Spino Ghost Racing";
  const t = escapeHtml(title);
  const d = escapeHtml(description);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<meta name="sgr-og" content="${hash}">
<title>${t} – ${escapeHtml(what)}</title>
<meta name="description" content="${d}">
<meta name="apple-itunes-app" content="app-id=6753791318, app-argument=${url}">
<link rel="canonical" href="${url}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Spino Ghost Racing">
<meta property="og:url" content="${url}">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:image" content="${image}">
<meta property="og:image:secure_url" content="${image}">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="${W}">
<meta property="og:image:height" content="${H}">
<meta property="og:image:alt" content="${escapeHtml(alt)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">
<meta name="twitter:image" content="${image}">
<meta name="twitter:image:alt" content="${escapeHtml(alt)}">
<style>
  body{margin:0;background:#0f1015;color:#f4f4f5;font:16px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;display:grid;place-items:center;min-height:100vh}
  main{box-sizing:border-box;width:100%;max-width:560px;padding:28px 20px;text-align:center}
  .art{width:100%;height:auto;border-radius:14px;display:block;margin:0 0 20px}
  h1{font-size:26px;margin:0 0 8px;color:#eab308}
  p{color:#cfd2dc;margin:0 0 16px}
  .open{display:block;margin:0 auto 20px;max-width:280px;padding:14px 18px;border-radius:12px;background:#ef4444;color:#fff;font-weight:700;letter-spacing:.04em;text-decoration:none}
  .stores{display:flex;gap:12px;justify-content:center;align-items:center;flex-wrap:wrap;margin:0 0 20px}
  .stores img{height:48px;width:auto;display:block}
  .small{font-size:13px;color:#8b8f9c}
  .small a{color:#8b8f9c}
</style><link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48"><link rel="icon" type="image/png" sizes="96x96" href="/assets/favicon-96.png"><link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">
</head>
<body><main>
  <img class="art" src="og.png?v=${hash.slice(0, 10)}" width="${W}" height="${H}" alt="${escapeHtml(alt)}">
  <h1>${t}</h1>
  <p>${d}</p>
  <a class="open" href="spinoghostracing://${dir}/${id}">OPEN IN THE GAME</a>
  <p class="small">No game yet? Get it below, then tap the link again.</p>
  <div class="stores">
    <a href="https://apps.apple.com/app/spino-ghost-racing/id6753791318"><img src="/assets/app-store-badge.svg" alt="Download on the App Store"></a>
    <a href="https://play.google.com/store/apps/details?id=com.indest.spinoghostracing"><img src="/assets/google-play-badge.png" alt="Get it on Google Play"></a>
  </div>
  <p class="small"><a href="/">spinoghostracing.com</a></p>
</main></body></html>
`;
}

// ------------------------------------------------------------------- the run

function hashOf(obj) {
  return crypto.createHash("sha256").update(JSON.stringify({ v: RENDER_VERSION, looks: LOOKS_HASH, ...obj })).digest("hex");
}

function existingHash(file) {
  try {
    const m = fs.readFileSync(file, "utf8").match(/<meta name="sgr-og" content="([0-9a-f]+)">/);
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "S"}`;
}

function trackItem(row) {
  const key = String(row.key || "");
  if (!key.startsWith("pub:")) return null;
  const id = key.slice(4).toLowerCase();
  if (!UUID.test(id)) return null;
  const pts = points(row.outline);
  const name = drawable(font.name, row.name) || "Track";
  const author = drawable(font.label, row.author);
  const laps = Math.max(1, Number(row.laps) || 3);
  const km = pts.length ? lengthKm(pts) : 0;
  const facts = [km > 0 ? `${km.toFixed(1)} km` : "", plural(laps, "LAP")].filter(Boolean).join("   ·   ");
  const by = author ? `BY ${author.toUpperCase()}` : "";
  const outline = pts.map((p) => [Math.round(p[0] * 2) / 2, Math.round(p[1] * 2) / 2]);
  return {
    kind: "track", id, name, facts, by, pts, lookKey: `pub:${id}`,
    title: String(row.name || "Track"),
    description: `${author ? `A track by ${row.author}` : "A track"} in Spino Ghost Racing. ${km > 0 ? `${km.toFixed(1)} km, ` : ""}${laps} lap${laps === 1 ? "" : "s"}.`,
    alt: `The ${String(row.name || "track")} circuit`,
    hash: hashOf({ kind: "track", name, facts, by, outline, lookKey: `pub:${id}` }),
  };
}

function cupItem(row, outlines) {
  const id = String(row.id || "").toLowerCase();
  if (!UUID.test(id)) return null;
  const stages = Array.isArray(row.stages) ? row.stages : [];
  // The first stage on the feed is the cup's picture: its circuit in its look.
  let pts = [];
  let lookKey = "";
  for (const s of stages) {
    const o = outlines.get(String(s && s.key || ""));
    if (o && o.length >= 3) {
      pts = o;
      lookKey = String(s.key).toLowerCase();
      break;
    }
  }
  const name = drawable(font.name, row.name) || "Championship";
  const author = drawable(font.label, row.author_name);
  const entrants = Number(row.entrants) || 0;
  const facts = [plural(stages.length, "STAGE"), entrants > 0 ? plural(entrants, "RACER") : ""].filter(Boolean).join("   ·   ");
  const by = author ? `BY ${author.toUpperCase()}` : "";
  const outline = pts.map((p) => [Math.round(p[0] * 2) / 2, Math.round(p[1] * 2) / 2]);
  return {
    kind: "cup", id, name, facts, by, pts, lookKey,
    title: String(row.name || "Championship"),
    description: `A championship${author ? ` by ${row.author_name}` : ""} in Spino Ghost Racing: ${stages.length} stage${stages.length === 1 ? "" : "s"}.`,
    alt: `The ${String(row.name || "championship")} championship`,
    hash: hashOf({ kind: "cup", name, facts, by, outline, lookKey }),
  };
}

// Levels read this run, by key: a cup's stage is often a track drawn as well.
const looks = new Map();
function lookOf(key) {
  if (!looks.has(key)) looks.set(key, levelText(key).then(parseLevel));
  return looks.get(key);
}

function managed(dir) {
  const root = path.join(OUT, dir);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter((n) => UUID.test(n) && fs.existsSync(path.join(root, n, "index.html")));
}

async function main() {
  const data = FIXTURE ? JSON.parse(fs.readFileSync(FIXTURE, "utf8")) : await liveData();
  const tracks = (data.tracks || []).map(trackItem).filter(Boolean);
  const outlines = new Map((data.tracks || []).map((r) => [String(r.key || ""), points(r.outline)]));
  const cups = (data.cups || []).map((r) => cupItem(r, outlines)).filter(Boolean);
  const want = { t: new Set(tracks.map((i) => i.id)), c: new Set(cups.map((i) => i.id)) };

  // An answer that would take away more than half the pages is not trusted.
  for (const dir of ["t", "c"]) {
    const have = managed(dir);
    const gone = have.filter((id) => !want[dir].has(id));
    if (!FORCE && have.length >= 4 && gone.length > have.length / 2) {
      throw new Error(`${dir}/: the answer would remove ${gone.length} of ${have.length} pages; not trusted (--force to allow)`);
    }
  }

  let written = 0;
  let kept = 0;
  let plain = 0;
  let later = 0;
  for (const item of [...tracks, ...cups]) {
    const dir = path.join(OUT, item.kind === "cup" ? "c" : "t", item.id);
    const html = path.join(dir, "index.html");
    if (existingHash(html) === item.hash && fs.existsSync(path.join(dir, "og.png"))) {
      kept += 1;
      continue;
    }
    // The track's own look from its level; the feed's outline in the
    // defaults when the level is gone or broken; nothing written this run
    // — the page as it was — when the server could not be reached. Each
    // said aloud: a ::warning:: is an annotation on the run.
    let look = null;
    if (item.lookKey) {
      try {
        look = await lookOf(item.lookKey);
      } catch (e) {
        if (e instanceof Retry) {
          console.log(`::warning::${item.kind} ${item.id}: ${e.message} — left for the next run`);
          later += 1;
          continue;
        }
        console.log(`::warning::${item.kind} ${item.id}: ${e.message} — drawn from the feed's outline`);
        look = outlineLook(item.pts);
        plain += 1;
      }
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "og.png"), png(picture({ ...item, look })));
    fs.writeFileSync(html, page(item));
    written += 1;
  }
  let removed = 0;
  for (const dir of ["t", "c"]) {
    for (const id of managed(dir)) {
      if (!want[dir].has(id)) {
        fs.rmSync(path.join(OUT, dir, id), { recursive: true, force: true });
        removed += 1;
      }
    }
  }
  console.log(`link previews: ${tracks.length} tracks, ${cups.length} championships; ${written} written (${plain} from the outline alone), ${kept} unchanged, ${later} left for the next run, ${removed} removed`);
}

main().catch((e) => {
  console.error(`link previews: FAILED — ${e.message}`);
  process.exit(1);
});
