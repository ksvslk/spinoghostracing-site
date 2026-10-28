// LINK PREVIEWS FOR THE GAME'S LINKS (2026-10-28).
//
// A track or a championship shared from the game (a tap on its minimap) is
// https://spinoghostracing.com/t/<uuid> or /c/<uuid>. Those addresses fell
// to 404.html, which answers with HTTP 404 and no preview tags, so X, Discord
// and the rest showed a bare line of text. This writes, for every published
// track and every championship on the feed, a page at that address with the
// preview tags and a 1200 x 630 picture of the circuit drawn in the game's
// colours: t/<uuid>/index.html + og.png, c/<uuid>/index.html + og.png.
//
//   node tools/og/build.mjs                    live: the game's own public feed
//   node tools/og/build.mjs --fixture f.json --out /tmp/x   from a file, elsewhere
//
// The live run reads SGR_SUPABASE_URL and SGR_SUPABASE_ANON_KEY — the same
// public coordinates the game ships with; the anon key reads only what any
// player's phone reads (the feed and cups RPCs). A page whose inputs have not
// changed is left as it is (its hash rides in a meta tag), so a run with
// nothing new writes nothing. Pages for tracks and cups that have left the
// feed — taken down, hidden, a cup a day past its end — are removed, but a
// run that would remove more than half of them stops instead: an empty or
// broken answer must not wipe the site.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import opentype from "opentype.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(HERE, "../..");
const HOST = "https://spinoghostracing.com";
// Bump to draw every picture again (a change of style).
const RENDER_VERSION = "1";
// World units per metre, as the game counts a track's length (hero_overlay.gd).
const PER_METRE = 9.3;
// The road's width in world units (level.gd DEFAULT_HALF_WIDTH, both sides).
const ROAD_WORLD = 300;
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

// The circuit as the race draws it: tarmac with red and white kerbs, a
// shadow under it, the chequered line at the first point across the road.
function circuit(pts, box) {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  // THE ROAD AT ITS OWN WIDTH for the scale (300 world units, the game's
  // default), between 8 and 24 px: a fixed width drowned a long narrow loop
  // in tarmac.
  const fit = (pad) => Math.min((box.w - pad * 2) / Math.max(1, maxX - minX), (box.h - pad * 2) / Math.max(1, maxY - minY));
  const road = Math.max(8, Math.min(24, fit(36) * ROAD_WORLD));
  const pad = road + 12;
  const scale = fit(pad);
  const ox = box.x + (box.w - (maxX - minX) * scale) / 2;
  const oy = box.y + (box.h - (maxY - minY) * scale) / 2;
  const at = (p) => [ox + (p[0] - minX) * scale, oy + (p[1] - minY) * scale];
  const drawn = pts.map(at);
  const d = "M" + drawn.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" L") + " Z";
  const [x0, y0] = drawn[0];
  const [x1, y1] = drawn[Math.min(2, drawn.length - 1)];
  const angle = (Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI;
  const cell = (road + 8) / 4;
  let chequer = "";
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 4; col++) {
      const fill = (row + col) % 2 === 0 ? "#f4f4f5" : "#111216";
      chequer += `<rect x="${(row - 1) * cell}" y="${-2 * cell + col * cell}" width="${cell}" height="${cell}" fill="${fill}"/>`;
    }
  }
  return `
  <path d="${d}" fill="none" stroke="#000" stroke-opacity="0.45" stroke-width="${road + 18}" stroke-linejoin="round" transform="translate(0 8)"/>
  <path d="${d}" fill="none" stroke="#f4f4f5" stroke-width="${road + 9}" stroke-linejoin="round"/>
  <path d="${d}" fill="none" stroke="#ef4444" stroke-width="${road + 9}" stroke-linejoin="round" stroke-dasharray="11 11"/>
  <path d="${d}" fill="none" stroke="#2a2d34" stroke-width="${road}" stroke-linejoin="round"/>
  <g transform="translate(${x0.toFixed(1)} ${y0.toFixed(1)}) rotate(${angle.toFixed(1)})">${chequer}</g>`;
}

function picture({ kind, name, facts, by, pts }) {
  const left = 64;
  const textW = 470;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0f1015"/><stop offset="1" stop-color="#171b24"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#2b3a2e" stop-opacity="0.85"/><stop offset="1" stop-color="#2b3a2e" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <ellipse cx="880" cy="315" rx="340" ry="300" fill="url(#glow)"/>`;
  // The circuit, or the house's dino where a cup has no published stage.
  const art = { x: 580, y: 36, w: 580, h: 558 };
  if (pts.length >= 3) {
    svg += circuit(pts, art);
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
  if (facts) {
    y += 14 + 28;
    svg += textPath(font.facts, facts, left, y, 38, "#cfd2dc");
    y += 8;
  }
  if (by) {
    y += 12 + 21;
    svg += textPath(font.label, by, left, y, 28, "#eab308");
    y += 6;
  }
  svg += textPath(font.small, "Free on Android and iPhone", left, 586, 24, "#8b8f9c");
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
  return crypto.createHash("sha256").update(JSON.stringify({ v: RENDER_VERSION, ...obj })).digest("hex");
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
    kind: "track", id, name, facts, by, pts,
    title: String(row.name || "Track"),
    description: `${author ? `A track by ${row.author}` : "A track"} in Spino Ghost Racing. ${km > 0 ? `${km.toFixed(1)} km, ` : ""}${laps} lap${laps === 1 ? "" : "s"}. Race it free on Android and iPhone.`,
    alt: `The ${String(row.name || "track")} circuit`,
    hash: hashOf({ kind: "track", name, facts, by, outline }),
  };
}

function cupItem(row, outlines) {
  const id = String(row.id || "").toLowerCase();
  if (!UUID.test(id)) return null;
  const stages = Array.isArray(row.stages) ? row.stages : [];
  let pts = [];
  for (const s of stages) {
    const o = outlines.get(String(s && s.key || ""));
    if (o && o.length >= 3) {
      pts = o;
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
    kind: "cup", id, name, facts, by, pts,
    title: String(row.name || "Championship"),
    description: `A championship${author ? ` by ${row.author_name}` : ""} in Spino Ghost Racing: ${stages.length} stage${stages.length === 1 ? "" : "s"}. Race it free on Android and iPhone.`,
    alt: `The ${String(row.name || "championship")} championship`,
    hash: hashOf({ kind: "cup", name, facts, by, outline }),
  };
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
  for (const item of [...tracks, ...cups]) {
    const dir = path.join(OUT, item.kind === "cup" ? "c" : "t", item.id);
    const html = path.join(dir, "index.html");
    if (existingHash(html) === item.hash && fs.existsSync(path.join(dir, "og.png"))) {
      kept += 1;
      continue;
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "og.png"), png(picture(item)));
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
  console.log(`link previews: ${tracks.length} tracks, ${cups.length} championships; ${written} written, ${kept} unchanged, ${removed} removed`);
}

main().catch((e) => {
  console.error(`link previews: FAILED — ${e.message}`);
  process.exit(1);
});
