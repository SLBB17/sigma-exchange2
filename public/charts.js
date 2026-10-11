"use strict";

// Graphiques maison en SVG : aucune bibliothèque externe.

const UP_COLOR = "#34d399";
const DOWN_COLOR = "#fb7185";

function sparkline(values, width = 120, height = 38) {
  const data = (values || []).map(Number).filter(Number.isFinite);

  if (data.length < 2) {
    return `<svg class="spark" viewBox="0 0 ${width} ${height}" aria-hidden="true">
      <line x1="0" y1="${height / 2}" x2="${width}" y2="${height / 2}" stroke="#64748b" stroke-dasharray="3 4"/>
    </svg>`;
  }

  const color = data[data.length - 1] >= data[0] ? UP_COLOR : DOWN_COLOR;
  const id = nextSvgId("sp");
  let min = Math.min(...data);
  let max = Math.max(...data);
  if (min === max) { min *= 0.99; max *= 1.01; }

  const pad = 3;
  const x = (i) => (i / (data.length - 1)) * width;
  const y = (v) => pad + (1 - (v - min) / (max - min)) * (height - pad * 2);

  const line = data.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const area = `${line} L${width} ${height} L0 ${height} Z`;

  return `<svg class="spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
    <defs>
      <linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${color}" stop-opacity=".35"/>
        <stop offset="1" stop-color="${color}" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <path d="${area}" fill="url(#${id})"/>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

function axisTimeLabel(timestamp, range) {
  const date = new Date(timestamp);
  if (range === "3d") {
    return date.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" }) +
      " " + date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

// Courbe interactive : survole le graphique pour lire le cours à chaque instant.
function renderLineChart(container, points, options = {}) {
  const range = options.range || "6h";

  if (!points || points.length < 2) {
    container.innerHTML = '<p class="muted chart-empty">Pas encore assez de données pour ce graphique.</p>';
    return;
  }

  const W = 720;
  const H = 300;
  const padL = 62;
  const padR = 14;
  const padT = 14;
  const padB = 30;
  const n = points.length;

  const color = options.color ||
    (points[n - 1].p >= points[0].p ? UP_COLOR : DOWN_COLOR);
  const id = nextSvgId("ch");

  const prices = points.map((point) => point.p);
  let min = Math.min(...prices);
  let max = Math.max(...prices);
  if (min === max) { min *= 0.99; max *= 1.01; }
  const margin = (max - min) * 0.08;
  min -= margin;
  max += margin;

  const x = (i) => padL + (i / (n - 1)) * (W - padL - padR);
  const y = (value) => padT + (1 - (value - min) / (max - min)) * (H - padT - padB);

  let grid = "";
  for (let k = 0; k <= 4; k += 1) {
    const value = min + ((max - min) * k) / 4;
    const gy = y(value).toFixed(1);
    grid += `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="#ffffff" stroke-opacity=".07"/>
      <text x="${padL - 8}" y="${gy}" font-size="11" fill="#94a3b8" text-anchor="end" dy=".35em">${fmtPrice(value)}</text>`;
  }

  let ticks = "";
  for (let k = 0; k <= 4; k += 1) {
    const index = Math.round((k * (n - 1)) / 4);
    const anchor = k === 0 ? "start" : k === 4 ? "end" : "middle";
    ticks += `<text x="${x(index).toFixed(1)}" y="${H - 8}" font-size="11" fill="#94a3b8" text-anchor="${anchor}">${axisTimeLabel(points[index].t, range)}</text>`;
  }

  const line = points.map((point, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(point.p).toFixed(1)}`).join(" ");
  const area = `${line} L${x(n - 1).toFixed(1)} ${H - padB} L${x(0).toFixed(1)} ${H - padB} Z`;

  container.innerHTML = `<div class="chart-box">
    <svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img" aria-label="Évolution du cours">
      <defs>
        <linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="${color}" stop-opacity=".32"/>
          <stop offset="1" stop-color="${color}" stop-opacity="0"/>
        </linearGradient>
      </defs>
      ${grid}${ticks}
      <path d="${area}" fill="url(#${id})"/>
      <path d="${line}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
      <line class="chart-cursor" x1="0" y1="${padT}" x2="0" y2="${H - padB}" stroke="#fff" stroke-opacity=".35" stroke-dasharray="3 4" style="display:none"/>
      <circle class="chart-dot" r="5" fill="${color}" stroke="#0b0d14" stroke-width="2" style="display:none"/>
    </svg>
    <div class="chart-tip hidden"></div>
  </div>`;

  const svg = $("svg", container);
  const cursor = $(".chart-cursor", container);
  const dot = $(".chart-dot", container);
  const tip = $(".chart-tip", container);

  const hide = () => {
    cursor.style.display = "none";
    dot.style.display = "none";
    tip.classList.add("hidden");
  };

  svg.addEventListener("pointermove", (event) => {
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;

    const sx = ((event.clientX - rect.left) / rect.width) * W;
    const ratio = (sx - padL) / (W - padL - padR);
    const index = Math.min(n - 1, Math.max(0, Math.round(ratio * (n - 1))));
    const point = points[index];
    const px = x(index);
    const py = y(point.p);

    cursor.setAttribute("x1", px);
    cursor.setAttribute("x2", px);
    cursor.style.display = "";
    dot.setAttribute("cx", px);
    dot.setAttribute("cy", py);
    dot.style.display = "";

    tip.innerHTML = `<strong>${fmtPrice(point.p)}</strong><span>${axisTimeLabel(point.t, range)}</span>`;
    tip.style.left = `${Math.min(88, Math.max(12, (px / W) * 100))}%`;
    tip.style.top = `${(py / H) * 100}%`;
    tip.classList.remove("hidden");
  });

  svg.addEventListener("pointerleave", hide);
}

// Anneau de répartition (portefeuille).
function renderDonut(items, center = {}) {
  const data = items.filter((item) => item.value > 0);
  const total = data.reduce((sum, item) => sum + item.value, 0);
  const radius = 70;
  const circumference = 2 * Math.PI * radius;

  if (!total) {
    return '<p class="muted">Rien à afficher pour le moment.</p>';
  }

  let offset = 0;
  const segments = data.map((item) => {
    const length = (item.value / total) * circumference;
    const segment = `<circle cx="100" cy="100" r="${radius}" fill="none" stroke="${item.color}" stroke-width="26"
      stroke-dasharray="${length.toFixed(2)} ${(circumference - length).toFixed(2)}"
      stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 100 100)"/>`;
    offset += length;
    return segment;
  }).join("");

  const legend = data.map((item) => `<li>
      <span class="dot" style="background:${item.color}"></span>
      <span class="legend-label">${escapeHtml(item.label)}</span>
      <strong>${((item.value / total) * 100).toFixed(1).replace(".", ",")} %</strong>
    </li>`).join("");

  return `<div class="donut">
    <svg viewBox="0 0 200 200" class="donut-svg" role="img" aria-label="Répartition du patrimoine">
      <circle cx="100" cy="100" r="${radius}" fill="none" stroke="#ffffff" stroke-opacity=".06" stroke-width="26"/>
      ${segments}
      <text x="100" y="94" text-anchor="middle" font-size="11" fill="#94a3b8">${escapeHtml(center.title || "")}</text>
      <text x="100" y="114" text-anchor="middle" font-size="15" font-weight="800" fill="#fff">${escapeHtml(center.value || "")}</text>
    </svg>
    <ul class="donut-legend">${legend}</ul>
  </div>`;
}

// Histogramme simple (activité de l'administration).
function renderBars(items, options = {}) {
  const W = 720;
  const H = options.height || 160;
  const padB = 22;
  const gap = 4;
  const max = Math.max(1, ...items.map((item) => item.value));
  const barWidth = (W - gap * (items.length - 1)) / items.length;

  const bars = items.map((item, i) => {
    const h = (item.value / max) * (H - padB - 14);
    const bx = i * (barWidth + gap);
    const by = H - padB - h;
    const label = i % Math.ceil(items.length / 8) === 0
      ? `<text x="${(bx + barWidth / 2).toFixed(1)}" y="${H - 6}" font-size="10" fill="#94a3b8" text-anchor="middle">${escapeHtml(item.label)}</text>`
      : "";

    return `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${Math.max(h, 1).toFixed(1)}" rx="3" fill="#a78bfa" opacity="${item.value ? 0.9 : 0.25}">
      <title>${escapeHtml(item.label)} : ${item.value}</title></rect>${label}`;
  }).join("");

  return `<svg viewBox="0 0 ${W} ${H}" class="bars-svg" role="img" aria-label="${escapeHtml(options.label || "Histogramme")}">${bars}</svg>`;
}
