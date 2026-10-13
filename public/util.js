"use strict";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

// État partagé entre tous les fichiers du site.
const state = {
  user: null,
  authMode: "login",
  assets: [],
  holdings: [],
  balance: 0,
  cards: [],
  packs: [],
  titles: [],
  friends: { friends: [], incoming: [], outgoing: [] },
  bazaar: { view: "buy", filter: { search: "", rarity: "", seller: "all", sort: "floor-asc" } },
  range: "6h",
  marketFilter: { search: "", sector: "", sort: "name" },
  collectionFilter: { search: "", rarity: "", ownedOnly: false }
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;",
    '"': "&quot;", "'": "&#39;"
  })[char]);
}

function money(value) {
  return Number(value || 0).toLocaleString("fr-FR", {
    style: "decimal",
    maximumFractionDigits: 2
  }) + " crédits";
}

function fmtPrice(value) {
  return Number(value || 0).toLocaleString("fr-FR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function fmtQty(value) {
  return Number(value || 0).toLocaleString("fr-FR", {
    maximumFractionDigits: 4
  });
}

function fmtPct(value) {
  const number = Number(value || 0);
  const sign = number > 0 ? "+" : "";
  return `${sign}${number.toFixed(2).replace(".", ",")} %`;
}

function trendClass(value) {
  const number = Number(value || 0);
  return number > 0 ? "up" : number < 0 ? "down" : "flat";
}

function fmtDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("fr-FR", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"
  });
}

function fmtAgo(value) {
  if (!value) return "il y a longtemps";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 90) return "à l'instant";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  return `il y a ${Math.round(hours / 24)} j`;
}

function debounce(callback, delay) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => callback(...args), delay);
  };
}

function fmtTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers
    }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = (data.error || "Une erreur est survenue.") +
      (data.detail ? ` (${data.detail})` : "");
    const suspended = response.status === 403 && /suspendu/i.test(message);

    // Session expirée ou compte suspendu pendant l'utilisation.
    if ((response.status === 401 || suspended) && state.user &&
        typeof handleSessionExpired === "function") {
      handleSessionExpired(suspended ? message : "Ta session a expiré. Reconnecte-toi.");
    }

    throw new Error(message);
  }

  return data;
}

function jsonBody(payload) {
  return JSON.stringify(payload);
}

/* ----- Notifications ----- */

function toast(message, type = "info") {
  const host = $("#toasts");
  if (!host || !message) return;

  const item = document.createElement("div");
  item.className = `toast ${type}`;
  item.textContent = message;
  host.appendChild(item);

  while (host.children.length > 4) host.firstElementChild.remove();

  setTimeout(() => item.classList.add("leaving"), 3800);
  setTimeout(() => item.remove(), 4300);
}

function toastError(error) {
  toast(error && error.message ? error.message : String(error), "error");
}

function toastTitles(titles) {
  (titles || []).forEach((name) => toast(`Nouveau titre débloqué : ${name}`, "success"));
}

/* ----- Fenêtre modale ----- */

let modalLocked = false;
let modalOnClose = null;

function openModal(html, options = {}) {
  const modal = $("#modal");
  modalLocked = Boolean(options.locked);
  modalOnClose = options.onClose || null;

  $("#modal-body").innerHTML = html;
  $("#modal-card").classList.toggle("wide", Boolean(options.wide));
  $("#modal-close").classList.toggle("hidden", modalLocked);
  modal.classList.remove("hidden");
  document.body.classList.add("modal-open");
  return $("#modal-body");
}

function closeModal(force = false) {
  if (modalLocked && !force) return;

  const callback = modalOnClose;
  modalOnClose = null;
  modalLocked = false;

  $("#modal").classList.add("hidden");
  $("#modal-body").innerHTML = "";
  document.body.classList.remove("modal-open");

  if (callback) callback();
}

function isModalOpen() {
  return !$("#modal").classList.contains("hidden");
}

function setupModal() {
  $("#modal-close").addEventListener("click", () => closeModal());
  $("#modal-backdrop").addEventListener("click", () => closeModal());
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isModalOpen()) closeModal();
  });
}

function setBusy(button, busy) {
  if (button) button.disabled = busy;
}
