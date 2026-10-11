"use strict";

// Tous les visuels sont générés en SVG : aucune image externe à charger.

let svgUid = 0;
const nextSvgId = (prefix) => `${prefix}${++svgUid}`;

const RARITY = {
  common: { label: "Commune", color: "#94a3b8", glow: "#64748b", bg: ["#1e293b", "#0f172a"], stars: 1 },
  rare: { label: "Rare", color: "#38bdf8", glow: "#0ea5e9", bg: ["#0c4a6e", "#082f49"], stars: 2 },
  epic: { label: "Épique", color: "#c084fc", glow: "#a855f7", bg: ["#581c87", "#2e1065"], stars: 3 },
  legendary: { label: "Légendaire", color: "#fbbf24", glow: "#f59e0b", bg: ["#78350f", "#451a03"], stars: 4 },
  mythic: { label: "Mythique", color: "#fb7185", glow: "#e11d48", bg: ["#881337", "#3b0764"], stars: 5 }
};

const RARITY_ORDER = ["common", "rare", "epic", "legendary", "mythic"];

const TIER_STYLE = {
  basic: ["#2dd4bf", "#0f766e"],
  silver: ["#e2e8f0", "#64748b"],
  premium: ["#60a5fa", "#4338ca"],
  legendary: ["#fbbf24", "#b45309"],
  mythic: ["#f472b6", "#7c3aed"]
};

function normalizeRarity(value) {
  const key = String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

  const map = {
    common: "common", commune: "common",
    rare: "rare",
    epic: "epic", epique: "epic",
    legendary: "legendary", legendaire: "legendary",
    mythic: "mythic", mythique: "mythic"
  };

  return map[key] || "common";
}

function rarityOf(card) {
  const key = card.rarityKey || normalizeRarity(card.rarity);
  return RARITY[key] ? key : "common";
}

function hashString(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

// Petit générateur pseudo-aléatoire : un même nom donne toujours le même décor.
function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function safeColor(color, fallback = "#a78bfa") {
  return /^#[0-9a-fA-F]{6}$/.test(String(color || "")) ? color : fallback;
}

// Assombrit (percent < 0) ou éclaircit (percent > 0) une couleur #rrggbb.
function shade(hex, percent) {
  const value = safeColor(hex).slice(1);
  const channels = [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16));
  const adjusted = channels.map((channel) => {
    const target = percent < 0 ? 0 : 255;
    const ratio = Math.abs(percent) / 100;
    return Math.round(channel + (target - channel) * ratio);
  });
  return "#" + adjusted.map((c) => c.toString(16).padStart(2, "0")).join("");
}

/* ----- Logo d'entreprise ----- */

function companyLogo(asset, size = 44) {
  const id = nextSvgId("lg");
  const color = safeColor(asset.color);
  const dark = shade(color, -55);
  const icon = escapeHtml(asset.icon || "📈");

  return `<svg class="logo" width="${size}" height="${size}" viewBox="0 0 64 64" role="img" aria-label="Logo ${escapeHtml(asset.name)}">
    <defs>
      <linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${color}"/><stop offset="1" stop-color="${dark}"/>
      </linearGradient>
    </defs>
    <rect width="64" height="64" rx="16" fill="url(#${id})"/>
    <circle cx="52" cy="10" r="24" fill="#fff" opacity=".13"/>
    <text x="32" y="33" font-size="30" text-anchor="middle" dy=".35em">${icon}</text>
  </svg>`;
}

/* ----- Carte à collectionner ----- */

function cardArt(card, options = {}) {
  const key = rarityOf(card);
  const rarity = RARITY[key];
  const locked = Boolean(options.locked);
  const id = nextSvgId("cd");
  const name = locked ? "???" : String(card.name || "");
  const emoji = locked ? "?" : (card.emoji || "🃏");
  const rand = seededRandom(hashString(String(card.name || "carte")));

  let sparkles = "";
  for (let i = 0; i < 18; i += 1) {
    const x = (10 + rand() * 180).toFixed(1);
    const y = (36 + rand() * 160).toFixed(1);
    const radius = (0.8 + rand() * 2.2).toFixed(1);
    const opacity = (0.15 + rand() * 0.55).toFixed(2);
    sparkles += `<circle cx="${x}" cy="${y}" r="${radius}" fill="${rarity.color}" opacity="${opacity}"/>`;
  }

  const border = key === "legendary" || key === "mythic"
    ? `<stop offset="0" stop-color="#fde68a"/><stop offset=".5" stop-color="${rarity.color}"/><stop offset="1" stop-color="${rarity.glow}"/>`
    : `<stop offset="0" stop-color="${rarity.color}"/><stop offset="1" stop-color="${rarity.glow}"/>`;

  const starRow = Array.from({ length: 5 }, (_, i) =>
    `<text x="${60 + i * 20}" y="34" font-size="13" text-anchor="middle" fill="${i < rarity.stars ? rarity.color : "#ffffff"}" opacity="${i < rarity.stars ? 1 : 0.18}">★</text>`
  ).join("");

  const fontSize = name.length > 20 ? 10.5 : name.length > 15 ? 12.5 : 15;
  const series = locked ? "" : escapeHtml(card.series || "");
  const label = `${rarity.label.toUpperCase()}${series ? " · " + series.toUpperCase() : ""}`;

  return `<svg class="card-svg" viewBox="0 0 200 280" role="img" aria-label="Carte ${escapeHtml(name)} (${rarity.label})">
    <defs>
      <linearGradient id="${id}b" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${rarity.bg[0]}"/><stop offset="1" stop-color="${rarity.bg[1]}"/>
      </linearGradient>
      <linearGradient id="${id}d" x1="0" y1="0" x2="1" y2="1">${border}</linearGradient>
      <radialGradient id="${id}g" cx="50%" cy="45%" r="55%">
        <stop offset="0" stop-color="${rarity.glow}" stop-opacity=".6"/>
        <stop offset="1" stop-color="${rarity.glow}" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect x="3" y="3" width="194" height="274" rx="16" fill="url(#${id}b)" stroke="url(#${id}d)" stroke-width="3"/>
    <rect x="12" y="12" width="176" height="256" rx="11" fill="none" stroke="${rarity.color}" stroke-opacity=".22"/>
    <ellipse cx="100" cy="128" rx="92" ry="92" fill="url(#${id}g)"/>
    <circle cx="100" cy="128" r="62" fill="none" stroke="${rarity.color}" stroke-opacity=".28" stroke-width="2"/>
    <circle cx="100" cy="128" r="82" fill="none" stroke="${rarity.color}" stroke-opacity=".14" stroke-width="1.5" stroke-dasharray="4 6"/>
    ${locked ? "" : sparkles}
    ${starRow}
    <text x="100" y="130" font-size="${locked ? 70 : 78}" text-anchor="middle" dy=".35em" ${locked ? 'fill="#94a3b8" opacity=".55"' : ""}>${escapeHtml(emoji)}</text>
    <rect x="12" y="204" width="176" height="64" rx="11" fill="#000" opacity=".42"/>
    <text x="100" y="231" font-size="${fontSize}" font-weight="800" text-anchor="middle" fill="#fff">${escapeHtml(name)}</text>
    <text x="100" y="251" font-size="8.5" letter-spacing="1.6" text-anchor="middle" fill="${rarity.color}">${label}</text>
  </svg>`;
}

function cardTile(card, options = {}) {
  const key = rarityOf(card);
  const quantity = Number(options.quantity || 0);

  return `<div class="tcg tcg-${key}${options.locked ? " locked" : ""}">
    ${cardArt(card, options)}
    ${quantity > 1 ? `<span class="tcg-qty">×${quantity}</span>` : ""}
    ${options.isNew ? '<span class="tcg-new">NEW</span>' : ""}
  </div>`;
}

// Dos de carte (avant retournement dans l'ouverture d'un pack).
function cardBack() {
  const id = nextSvgId("cb");

  return `<svg class="card-svg" viewBox="0 0 200 280" aria-hidden="true">
    <defs>
      <linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#312e81"/><stop offset="1" stop-color="#0f172a"/>
      </linearGradient>
    </defs>
    <rect x="3" y="3" width="194" height="274" rx="16" fill="url(#${id})" stroke="#a78bfa" stroke-width="3"/>
    <rect x="14" y="14" width="172" height="252" rx="10" fill="none" stroke="#a78bfa" stroke-opacity=".35"/>
    <circle cx="100" cy="140" r="56" fill="none" stroke="#a78bfa" stroke-opacity=".35" stroke-width="2"/>
    <text x="100" y="142" font-size="70" font-weight="900" text-anchor="middle" dy=".35em" fill="#a78bfa" opacity=".85">Σ</text>
  </svg>`;
}

/* ----- Pack de cartes ----- */

function packArt(pack) {
  const id = nextSvgId("pk");
  const [light, dark] = TIER_STYLE[pack.tier] || TIER_STYLE.basic;
  const rand = seededRandom(hashString(String(pack.name || "pack")));

  // Contour du sachet avec bords « crantés » en haut et en bas.
  const left = 16;
  const right = 184;
  const top = 18;
  const bottom = 242;
  let outline = `M${left} ${top}`;
  for (let x = left + 8, i = 0; x <= right; x += 8, i += 1) {
    outline += ` L${x} ${i % 2 ? top : top - 7}`;
  }
  outline += ` L${right} ${bottom}`;
  for (let x = right - 8, i = 0; x >= left; x -= 8, i += 1) {
    outline += ` L${x} ${i % 2 ? bottom : bottom + 7}`;
  }
  outline += " Z";

  let sparkles = "";
  for (let i = 0; i < 12; i += 1) {
    const x = (28 + rand() * 144).toFixed(1);
    const y = (36 + rand() * 190).toFixed(1);
    sparkles += `<text x="${x}" y="${y}" font-size="${(7 + rand() * 9).toFixed(0)}" fill="#fff" opacity="${(0.25 + rand() * 0.5).toFixed(2)}">✦</text>`;
  }

  const name = String(pack.name || "");
  const nameSize = name.length > 12 ? 14 : 18;
  const count = Number(pack.cardsPerPack) || 1;

  return `<svg class="pack-svg" viewBox="0 0 200 260" role="img" aria-label="Pack ${escapeHtml(name)}">
    <defs>
      <linearGradient id="${id}f" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${light}"/><stop offset="1" stop-color="${dark}"/>
      </linearGradient>
      <clipPath id="${id}c"><path d="${outline}"/></clipPath>
    </defs>
    <path d="${outline}" fill="url(#${id}f)" stroke="#fff" stroke-opacity=".5" stroke-width="2"/>
    <g clip-path="url(#${id}c)">
      <path d="M-30 280 L95 -20 L135 -20 L10 280 Z" fill="#fff" opacity=".14"/>
      <path d="M60 280 L185 -20 L200 -20 L75 280 Z" fill="#fff" opacity=".08"/>
      ${sparkles}
    </g>
    <circle cx="100" cy="98" r="50" fill="#000" opacity=".25"/>
    <circle cx="100" cy="98" r="50" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="2"/>
    <text x="100" y="100" font-size="58" text-anchor="middle" dy=".35em">${escapeHtml(pack.emoji || "📦")}</text>
    <text x="100" y="177" font-size="${nameSize}" font-weight="900" text-anchor="middle" fill="#fff">${escapeHtml(name.toUpperCase())}</text>
    <text x="100" y="196" font-size="9.5" letter-spacing="2" text-anchor="middle" fill="#fff" opacity=".9">${count} CARTE${count > 1 ? "S" : ""}</text>
    <rect x="62" y="210" width="76" height="18" rx="9" fill="#000" opacity=".35"/>
    <text x="100" y="222.5" font-size="9" font-weight="800" letter-spacing="1.5" text-anchor="middle" fill="#fff">${escapeHtml(String(pack.tierLabel || "STANDARD").toUpperCase())}</text>
  </svg>`;
}
