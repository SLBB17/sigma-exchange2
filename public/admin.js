"use strict";

const ADMIN_SECTIONS = [
  ["dashboard", "Tableau de bord"],
  ["users", "Utilisateurs"],
  ["packs", "Boutique"],
  ["market", "Marché"],
  ["cards", "Cartes"],
  ["bazaar", "Bazar"],
  ["comms", "Communication"],
  ["logs", "Journal"],
  ["diagnostic", "Diagnostic"]
];

const ADMIN_ACTIONS = {
  "user.update": "Modification d'un compte",
  "user.delete": "Suppression d'un compte",
  "user.grant_card": "Carte offerte",
  "user.grant_title": "Titre offert",
  "pack.create": "Pack créé",
  "pack.update": "Pack modifié",
  "shop.restock": "Stocks renouvelés",
  "asset.create": "Entreprise créée",
  "asset.update": "Entreprise modifiée",
  "market.event": "Événement de marché",
  "card.create": "Carte créée",
  "card.update": "Carte modifiée",
  "announcement.set": "Annonce modifiée",
  "chat.delete": "Message supprimé",
  "chat.clear": "Chat vidé",
  "listing.cancel": "Annonce du bazar retirée"
};

let adminSection = "dashboard";
let adminUsersCache = [];
let adminUserSearch = "";
let adminCardsCache = null;
let adminTitlesCache = null;
let adminAssetsCache = [];

function isAdminUser() {
  return Boolean(state.user && state.user.role === "admin");
}

function optionList(items, selected) {
  return items.map(([value, label]) =>
    `<option value="${escapeHtml(value)}"${String(value) === String(selected) ? " selected" : ""}>${escapeHtml(label)}</option>`
  ).join("");
}

const TIER_OPTIONS = [
  ["basic", "Standard"], ["silver", "Argent"], ["premium", "Premium"],
  ["legendary", "Légendaire"], ["mythic", "Mythique"]
];

const RARITY_OPTIONS = RARITY_ORDER.map((key) => [key, RARITY[key].label]);

// Lit les champs d'une ligne de tableau ou d'un formulaire (data-field).
function readFields(root) {
  const values = {};

  $$("[data-field]", root).forEach((input) => {
    const key = input.dataset.field;
    if (input.type === "checkbox") values[key] = input.checked;
    else if (input.type === "number") values[key] = input.value === "" ? undefined : Number(input.value);
    else values[key] = input.value;
  });

  return values;
}

function describeTransaction(transaction) {
  const details = transaction.details || {};

  if (transaction.type === "buy" || transaction.type === "sell") {
    return `${transaction.type === "buy" ? "Achat" : "Vente"} ${fmtQty(details.quantity)} × ${details.symbol || "?"} · ${money(details.total)}`;
  }

  if (transaction.type === "pack_purchase") {
    const cards = Array.isArray(details.cards) ? details.cards.join(", ") : "";
    return `Pack ${details.packName || ""} · ${cards}`;
  }

  return transaction.type;
}

function describeDetails(details) {
  try {
    const text = JSON.stringify(details || {});
    return text.length > 140 ? text.slice(0, 137) + "…" : text;
  } catch (error) {
    return "";
  }
}

/* ------------------------------------------------------------------ */
/* Navigation du panneau                                               */
/* ------------------------------------------------------------------ */

function setupAdmin() {
  $("#admin-nav").innerHTML = ADMIN_SECTIONS.map(([key, label]) =>
    `<button type="button" class="chip${key === adminSection ? " active" : ""}" data-section="${key}">${label}</button>`
  ).join("");

  $("#admin-nav").addEventListener("click", (event) => {
    const button = event.target.closest("[data-section]");
    if (!button) return;

    adminSection = button.dataset.section;
    $$("#admin-nav .chip").forEach((chip) => chip.classList.toggle("active", chip === button));
    loadAdminSection();
  });

  // Les actions de la page et celles de la fenêtre modale (fiche utilisateur)
  // sont gérées par les mêmes écouteurs.
  for (const selector of ["#admin-content", "#modal-body"]) {
    $(selector).addEventListener("click", onAdminClick);
    $(selector).addEventListener("submit", onAdminSubmit);
  }
}

function loadAdminPanel() {
  if (!isAdminUser()) return Promise.resolve();
  return loadAdminSection();
}

async function loadAdminSection() {
  const box = $("#admin-content");
  box.innerHTML = '<p class="muted">Chargement…</p>';

  const loaders = {
    dashboard: adminDashboard,
    users: adminUsers,
    packs: adminPacks,
    market: adminMarket,
    cards: adminCards,
    bazaar: adminBazaar,
    comms: adminComms,
    logs: adminLogs,
    diagnostic: adminDiagnostic
  };

  try {
    await loaders[adminSection](box);
  } catch (error) {
    box.innerHTML = `<p class="message error">${escapeHtml(error.message)}</p>`;
  }
}

/* ------------------------------------------------------------------ */
/* Tableau de bord                                                     */
/* ------------------------------------------------------------------ */

async function adminDashboard(box) {
  const stats = await api("/api/admin/stats");

  const cards = [
    ["Utilisateurs", stats.users.total, `${stats.users.new24} nouveau(x) en 24 h`],
    ["Crédits en circulation", money(stats.users.credits), "Somme des soldes"],
    ["Actifs détenus", money(stats.holdingsValue), "Valeur au cours actuel"],
    ["Ordres en bourse", stats.trades24, "Sur 24 h"],
    ["Packs ouverts", stats.packs24, "Sur 24 h"],
    ["Cartes possédées", stats.cardsOwned, "Au total"],
    ["Messages du chat", stats.messages24, "Sur 24 h"],
    ["Comptes suspendus", stats.users.banned, "Actuellement"]
  ];

  const bars = renderBars(
    stats.hourly.map((item) => ({
      label: `${new Date(item.hour).getHours()} h`,
      value: Number(item.n)
    })),
    { label: "Opérations par heure" }
  );

  box.innerHTML = `
    <div class="stats-grid">
      ${cards.map(([label, value, hint]) =>
        `<article class="stat-card"><span>${label}</span><strong>${escapeHtml(value)}</strong><small>${hint}</small></article>`
      ).join("")}
    </div>

    <section class="panel">
      <h3>Opérations par heure (24 h)</h3>
      ${bars}
    </section>

    <div class="two-cols">
      <section class="panel">
        <h3>Patrimoines les plus élevés</h3>
        <ol class="rank-list">
          ${stats.richest.map((user) =>
            `<li><span>${escapeHtml(user.username)}</span><strong>${money(user.net)}</strong></li>`
          ).join("") || '<li class="muted">Aucun joueur.</li>'}
        </ol>
      </section>

      <section class="panel">
        <h3>Dernières opérations</h3>
        <ul class="activity-list">
          ${stats.recent.map((transaction) =>
            `<li><strong>${escapeHtml(transaction.username)}</strong>
              <span>${escapeHtml(describeTransaction(transaction))}</span>
              <small class="muted">${escapeHtml(fmtDateTime(transaction.created_at))}</small></li>`
          ).join("") || '<li class="muted">Aucune opération.</li>'}
        </ul>
      </section>
    </div>`;
}

/* ------------------------------------------------------------------ */
/* Utilisateurs                                                        */
/* ------------------------------------------------------------------ */

function renderAdminUsers() {
  const table = $("#admin-users-table");
  if (!table) return;

  $("#admin-user-count").textContent = `${adminUsersCache.length} compte(s)`;

  table.innerHTML = adminUsersCache.length
    ? `<div class="table-wrap"><table class="data-table">
        <thead><tr><th>Utilisateur</th><th>E-mail</th><th>Solde</th><th>Inscription</th><th></th></tr></thead>
        <tbody>${adminUsersCache.map((user) => {
          const muted = user.muted_until && new Date(user.muted_until) > new Date();
          return `<tr>
            <td><strong>${escapeHtml(user.username)}</strong>
              ${user.role === "admin" ? '<span class="pill admin">Admin</span>' : ""}
              ${user.banned ? '<span class="pill danger">Suspendu</span>' : ""}
              ${muted ? '<span class="pill warn">Muet</span>' : ""}</td>
            <td>${user.email ? escapeHtml(user.email) : '<span class="down">manquant</span>'}</td>
            <td>${money(user.balance)}</td>
            <td>${escapeHtml(fmtDateTime(user.created_at))}</td>
            <td class="actions"><button type="button" class="button secondary small" data-admin="user-open" data-id="${Number(user.id)}">Gérer</button></td>
          </tr>`;
        }).join("")}</tbody></table></div>`
    : '<p class="muted">Aucun utilisateur trouvé.</p>';
}

async function refreshAdminUsers() {
  const data = await api(`/api/admin/users?search=${encodeURIComponent(adminUserSearch)}`);
  adminUsersCache = data.users || [];
  renderAdminUsers();
}

async function adminUsers(box) {
  box.innerHTML = `
    <div class="admin-toolbar">
      <input id="admin-user-search" type="search" placeholder="Rechercher un pseudo ou un e-mail" value="${escapeHtml(adminUserSearch)}">
      <span id="admin-user-count" class="muted"></span>
    </div>
    <div id="admin-users-table"></div>`;

  $("#admin-user-search").addEventListener("input", debounce(async (event) => {
    adminUserSearch = event.target.value.trim();
    try { await refreshAdminUsers(); } catch (error) { toastError(error); }
  }, 300));

  await refreshAdminUsers();
}

async function ensureAdminCards() {
  if (!adminCardsCache) adminCardsCache = (await api("/api/admin/cards")).cards;
  return adminCardsCache;
}

async function ensureAdminTitles() {
  if (!adminTitlesCache) adminTitlesCache = (await api("/api/admin/titles")).titles;
  return adminTitlesCache;
}

async function openUserModal(userId) {
  const user = adminUsersCache.find((item) => item.id === userId);
  if (!user) return;

  const [cards, titles] = await Promise.all([ensureAdminCards(), ensureAdminTitles()]);
  const self = user.id === state.user.id;
  const muted = user.muted_until && new Date(user.muted_until) > new Date();

  openModal(`
    <h2>${escapeHtml(user.username)}</h2>
    <p class="muted">Compte n° ${Number(user.id)} · inscrit le ${escapeHtml(fmtDateTime(user.created_at))} · solde ${money(user.balance)}
      ${muted ? ` · muet jusqu'au ${escapeHtml(fmtDateTime(user.muted_until))}` : ""}</p>

    <div class="admin-grid">
      <form data-form="user-email" data-id="${Number(user.id)}" class="admin-box">
        <h3>E-mail</h3>
        <input type="email" data-field="email" maxlength="254" value="${escapeHtml(user.email || "")}" placeholder="adresse@exemple.fr">
        <button type="submit" class="button secondary small">Enregistrer</button>
      </form>

      <form data-form="user-balance" data-id="${Number(user.id)}" class="admin-box">
        <h3>Solde</h3>
        <select data-field="mode">${optionList([["add", "Ajouter / retirer"], ["set", "Définir le solde"]], "add")}</select>
        <input type="number" step="0.01" data-field="amount" placeholder="Montant (négatif pour retirer)" required>
        <button type="submit" class="button secondary small">Appliquer</button>
      </form>

      <form data-form="user-role" data-id="${Number(user.id)}" class="admin-box">
        <h3>Rôle</h3>
        <select data-field="role" ${self ? "disabled" : ""}>${optionList([["user", "Joueur"], ["admin", "Administrateur"]], user.role)}</select>
        <button type="submit" class="button secondary small" ${self ? "disabled" : ""}>Changer le rôle</button>
      </form>

      <form data-form="user-mute" data-id="${Number(user.id)}" class="admin-box">
        <h3>Silence dans le chat</h3>
        <select data-field="minutes">${optionList([[0, "Lever le silence"], [15, "15 minutes"], [60, "1 heure"], [1440, "24 heures"], [10080, "7 jours"]], 0)}</select>
        <button type="submit" class="button secondary small">Appliquer</button>
      </form>

      <form data-form="user-card" data-id="${Number(user.id)}" class="admin-box">
        <h3>Offrir une carte</h3>
        <select data-field="cardId">${optionList(cards.map((card) => [card.id, `${card.emoji} ${card.name} (${RARITY[rarityOf(card)].label})`]), "")}</select>
        <input type="number" min="1" max="100" value="1" data-field="quantity">
        <button type="submit" class="button secondary small">Offrir</button>
      </form>

      <form data-form="user-title" data-id="${Number(user.id)}" class="admin-box">
        <h3>Offrir un titre</h3>
        <select data-field="titleId">${optionList(titles.map((title) => [title.id, title.name]), "")}</select>
        <button type="submit" class="button secondary small">Offrir</button>
      </form>
    </div>

    <div class="admin-danger">
      <button type="button" class="button secondary" data-admin="user-ban" data-id="${Number(user.id)}" data-banned="${user.banned ? "1" : "0"}" ${self ? "disabled" : ""}>
        ${user.banned ? "Réactiver le compte" : "Suspendre le compte"}
      </button>
      <button type="button" class="button danger" data-admin="user-delete" data-id="${Number(user.id)}" ${self ? "disabled" : ""}>Supprimer le compte</button>
    </div>`, { wide: true });
}

async function afterUserChange(userId) {
  await refreshAdminUsers();
  if (adminUsersCache.some((user) => user.id === userId)) {
    await openUserModal(userId);
  } else {
    closeModal();
  }
}

/* ------------------------------------------------------------------ */
/* Boutique                                                            */
/* ------------------------------------------------------------------ */

async function adminPacks(box) {
  const data = await api("/api/admin/packs");

  box.innerHTML = `
    <div class="admin-toolbar">
      <button type="button" class="button primary" data-admin="restock">Renouveler tous les stocks</button>
      <span class="muted">Les stocks augmentent aussi automatiquement toutes les 5 minutes.</span>
    </div>

    <div class="table-wrap"><table class="data-table admin-edit">
      <thead><tr><th>Pack</th><th>Prix</th><th>Stock</th><th>Cartes</th><th>Niveau</th><th>Emoji</th><th>Actif</th><th></th></tr></thead>
      <tbody>${data.packs.map((pack) => `<tr data-id="${Number(pack.id)}">
        <td><input data-field="name" value="${escapeHtml(pack.name)}" maxlength="100">
            <input data-field="description" value="${escapeHtml(pack.description)}" maxlength="300" placeholder="Description"></td>
        <td><input type="number" data-field="price" min="0" step="0.01" value="${escapeHtml(pack.price)}"></td>
        <td><input type="number" data-field="stock" min="0" step="1" value="${Number(pack.stock)}"></td>
        <td><input type="number" data-field="cardsPerPack" min="1" max="10" step="1" value="${Number(pack.cardsPerPack)}"></td>
        <td><select data-field="tier">${optionList(TIER_OPTIONS, pack.tier)}</select></td>
        <td><input data-field="emoji" maxlength="8" value="${escapeHtml(pack.emoji)}" class="tiny"></td>
        <td><input type="checkbox" data-field="active" ${pack.active ? "checked" : ""}></td>
        <td class="actions"><button type="button" class="button secondary small" data-admin="pack-save">Enregistrer</button></td>
      </tr>`).join("")}</tbody></table></div>

    <form data-form="pack-create" class="panel admin-create">
      <h3>Créer un pack</h3>
      <div class="form-row">
        <input data-field="name" placeholder="Nom" maxlength="100" required>
        <input data-field="description" placeholder="Description" maxlength="300">
        <input type="number" data-field="price" placeholder="Prix" min="0" step="0.01" required>
        <input type="number" data-field="stock" placeholder="Stock" min="0" step="1" value="10" required>
        <input type="number" data-field="cardsPerPack" placeholder="Cartes" min="1" max="10" value="3" required>
        <select data-field="tier">${optionList(TIER_OPTIONS, "basic")}</select>
        <input data-field="emoji" placeholder="Emoji" maxlength="8" value="📦" class="tiny" required>
      </div>
      <button type="submit" class="button primary">Créer le pack</button>
    </form>`;
}

/* ------------------------------------------------------------------ */
/* Marché                                                              */
/* ------------------------------------------------------------------ */

async function adminMarket(box) {
  const data = await api("/api/admin/assets");
  adminAssetsCache = data.assets;

  box.innerHTML = `
    <form data-form="market-event" class="panel admin-create">
      <h3>Événement de marché</h3>
      <p class="muted">Applique une hausse ou une baisse immédiate. Les cours reviennent ensuite progressivement vers leur niveau de référence.</p>
      <div class="form-row">
        <select data-field="symbol">
          <option value="ALL">Toutes les entreprises</option>
          ${optionList(adminAssetsCache.filter((a) => a.active).map((a) => [a.symbol, `${a.symbol} · ${a.name}`]), "")}
        </select>
        <input type="number" data-field="percent" step="0.1" min="-90" max="500" placeholder="Variation en %" required>
        <div class="quick">
          ${[-30, -10, 10, 30].map((value) =>
            `<button type="button" class="chip" data-admin="event-preset" data-percent="${value}">${value > 0 ? "+" : ""}${value} %</button>`
          ).join("")}
        </div>
      </div>
      <button type="submit" class="button primary">Appliquer l'événement</button>
    </form>

    <div class="table-wrap"><table class="data-table admin-edit">
      <thead><tr><th>Entreprise</th><th>Secteur</th><th>Cours</th><th>Volatilité</th><th>Icône</th><th>Actif</th><th></th></tr></thead>
      <tbody>${adminAssetsCache.map((asset) => `<tr data-symbol="${escapeHtml(asset.symbol)}" data-price="${Number(asset.price).toFixed(2)}">
        <td><div class="cell-company">${companyLogo({ ...asset, icon: asset.icon, color: asset.color }, 30)}
          <div><strong>${escapeHtml(asset.symbol)}</strong>
          <input data-field="name" value="${escapeHtml(asset.name)}" maxlength="100"></div></div>
          <input data-field="description" value="${escapeHtml(asset.description || "")}" maxlength="300" placeholder="Description"></td>
        <td><input data-field="sector" value="${escapeHtml(asset.sector || "")}" maxlength="40"></td>
        <td><input type="number" data-field="price" min="0.01" step="0.01" value="${Number(asset.price).toFixed(2)}"></td>
        <td><input type="number" data-field="volatility" min="0.001" max="0.05" step="0.001" value="${Number(asset.volatility || 0.012)}"></td>
        <td><input data-field="icon" value="${escapeHtml(asset.icon || "")}" maxlength="8" class="tiny"></td>
        <td><input type="checkbox" data-field="active" ${asset.active ? "checked" : ""}></td>
        <td class="actions"><button type="button" class="button secondary small" data-admin="asset-save">Enregistrer</button></td>
      </tr>`).join("")}</tbody></table></div>

    <form data-form="asset-create" class="panel admin-create">
      <h3>Ajouter une entreprise</h3>
      <div class="form-row">
        <input data-field="symbol" placeholder="Symbole (ex. ABC)" maxlength="8" required>
        <input data-field="name" placeholder="Nom" maxlength="100" required>
        <input data-field="sector" placeholder="Secteur" maxlength="40" required>
        <input type="number" data-field="price" placeholder="Cours initial" min="0.01" step="0.01" required>
        <input type="number" data-field="volatility" placeholder="Volatilité" min="0.001" max="0.05" step="0.001" value="0.012" required>
        <input data-field="icon" placeholder="Emoji" maxlength="8" value="📈" class="tiny" required>
        <input type="color" data-field="color" value="#a78bfa" class="color-input" aria-label="Couleur">
      </div>
      <input data-field="description" placeholder="Description" maxlength="300">
      <button type="submit" class="button primary">Ajouter l'entreprise</button>
    </form>`;
}

/* ------------------------------------------------------------------ */
/* Cartes                                                              */
/* ------------------------------------------------------------------ */

async function adminCards(box) {
  adminCardsCache = null;
  const cards = await ensureAdminCards();

  box.innerHTML = `
    <form data-form="card-create" class="panel admin-create">
      <h3>Créer une carte</h3>
      <div class="form-row">
        <input data-field="name" placeholder="Nom" maxlength="100" required>
        <select data-field="rarity">${optionList(RARITY_OPTIONS, "common")}</select>
        <input data-field="emoji" placeholder="Emoji" maxlength="8" value="🃏" class="tiny" required>
        <input data-field="series" placeholder="Série" maxlength="40">
      </div>
      <input data-field="description" placeholder="Description" maxlength="300">
      <button type="submit" class="button primary">Créer la carte</button>
    </form>

    <p class="muted">${cards.length} carte(s) au total.</p>
    <div class="table-wrap"><table class="data-table admin-edit">
      <thead><tr><th>Aperçu</th><th>Carte</th><th>Rareté</th><th>Emoji</th><th>Série</th><th>Possédées</th><th></th></tr></thead>
      <tbody>${cards.map((card) => `<tr data-id="${Number(card.id)}">
        <td class="card-thumb">${cardTile(card, { quantity: 0 })}</td>
        <td><input data-field="name" value="${escapeHtml(card.name)}" maxlength="100">
            <input data-field="description" value="${escapeHtml(card.description)}" maxlength="300" placeholder="Description"></td>
        <td><select data-field="rarity">${optionList(RARITY_OPTIONS, card.rarityKey)}</select></td>
        <td><input data-field="emoji" value="${escapeHtml(card.emoji)}" maxlength="8" class="tiny"></td>
        <td><input data-field="series" value="${escapeHtml(card.series)}" maxlength="40"></td>
        <td>${Number(card.owned)}</td>
        <td class="actions"><button type="button" class="button secondary small" data-admin="card-save">Enregistrer</button></td>
      </tr>`).join("")}</tbody></table></div>`;
}

/* ------------------------------------------------------------------ */
/* Bazar de cartes                                                     */
/* ------------------------------------------------------------------ */

const LISTING_STATUS = { active: "En vente", sold: "Vendue", cancelled: "Retirée" };

async function adminBazaar(box) {
  const data = await api("/api/admin/listings");

  box.innerHTML = data.listings.length
    ? `<p class="muted">Les ${data.listings.length} dernières annonces. Retirer une annonce rend la carte à son vendeur.</p>
       <div class="table-wrap"><table class="data-table">
        <thead><tr><th>Carte</th><th>Vendeur</th><th>Prix</th><th>Statut</th><th>Acheteur</th><th>Date</th><th></th></tr></thead>
        <tbody>${data.listings.map((item) => `<tr>
          <td>${escapeHtml(item.card.emoji)} <strong>${escapeHtml(item.card.name)}</strong>
            <span class="pill" style="border-color:${RARITY[rarityOf(item.card)].color};color:${RARITY[rarityOf(item.card)].color}">${RARITY[rarityOf(item.card)].label}</span></td>
          <td>${escapeHtml(item.seller.username)}</td>
          <td>${money(item.price)}</td>
          <td>${escapeHtml(LISTING_STATUS[item.status] || item.status)}</td>
          <td>${item.buyer ? escapeHtml(item.buyer) : "—"}</td>
          <td>${escapeHtml(fmtDateTime(item.sold_at || item.created_at))}</td>
          <td class="actions">${item.status === "active"
            ? `<button type="button" class="button secondary small" data-admin="listing-cancel" data-id="${Number(item.id)}">Retirer</button>`
            : ""}</td>
        </tr>`).join("")}</tbody></table></div>`
    : '<p class="muted">Aucune annonce pour le moment.</p>';
}

/* ------------------------------------------------------------------ */
/* Communication et journal                                            */
/* ------------------------------------------------------------------ */

async function adminComms(box) {
  const current = await api("/api/announcement");

  box.innerHTML = `
    <form data-form="announcement" class="panel admin-create">
      <h3>Annonce du site</h3>
      <p class="muted">Le message s'affiche en haut du site pour tous les visiteurs. Laisse vide pour le retirer.</p>
      <textarea data-field="text" rows="3" maxlength="300" placeholder="Ex. Maintenance ce soir à 22 h">${escapeHtml(current.text)}</textarea>
      <button type="submit" class="button primary">Publier</button>
    </form>

    <section class="panel">
      <h3>Modération du chat</h3>
      <p class="muted">Tu peux supprimer un message avec la croix dans l'onglet Chat, ou réduire un joueur au silence depuis sa fiche.</p>
      <button type="button" class="button danger" data-admin="chat-clear">Vider tout le chat</button>
    </section>`;
}

async function adminLogs(box) {
  const data = await api("/api/admin/logs");

  box.innerHTML = data.logs.length
    ? `<div class="table-wrap"><table class="data-table">
        <thead><tr><th>Date</th><th>Admin</th><th>Action</th><th>Détails</th></tr></thead>
        <tbody>${data.logs.map((log) => `<tr>
          <td>${escapeHtml(fmtDateTime(log.created_at))}</td>
          <td>${escapeHtml(log.username || "—")}</td>
          <td>${escapeHtml(ADMIN_ACTIONS[log.action] || log.action)}</td>
          <td class="muted">${escapeHtml(describeDetails(log.details))}</td>
        </tr>`).join("")}</tbody></table></div>`
    : '<p class="muted">Aucune action enregistrée pour le moment.</p>';
}

/* ------------------------------------------------------------------ */
/* Diagnostic de la base de données                                    */
/* ------------------------------------------------------------------ */

let lastDiagnostic = null;

function diagnosticReport(data) {
  const lines = [`Diagnostic Sigma Exchange — ${new Date(data.checkedAt).toLocaleString("fr-FR")}`];
  data.checks.forEach((check) => {
    lines.push(`${check.ok ? "OK    " : "ÉCHEC "} ${check.name}${check.ok ? "" : ` : ${check.error}`}`);
  });
  return lines.join("\n");
}

async function adminDiagnostic(box) {
  const data = await api("/api/admin/diagnostics");
  lastDiagnostic = data;
  const failed = data.checks.filter((check) => !check.ok);

  box.innerHTML = `
    <div class="panel diagnostic-banner ${failed.length ? "bad" : "good"}">
      <strong>${failed.length
        ? `${failed.length} problème${failed.length > 1 ? "s" : ""} détecté${failed.length > 1 ? "s" : ""}`
        : "Tout fonctionne : toutes les vérifications ont réussi"}</strong>
      <span class="muted">${data.checks.length} vérifications · ${escapeHtml(fmtDateTime(data.checkedAt))}</span>
      <div class="detail-actions">
        <button type="button" class="button secondary small" data-admin="diagnostic-run">Relancer</button>
        <button type="button" class="button secondary small" data-admin="diagnostic-copy">Copier le rapport</button>
      </div>
    </div>
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th></th><th>Vérification</th><th>Détail</th></tr></thead>
      <tbody>${data.checks.map((check) => `<tr>
        <td class="${check.ok ? "up" : "down"}">${check.ok ? "✓" : "✗"}</td>
        <td>${escapeHtml(check.name)}</td>
        <td class="${check.ok ? "muted" : "down"}">${check.ok ? "OK" : escapeHtml(check.error)}</td>
      </tr>`).join("")}</tbody>
    </table></div>
    <p class="muted">Ces vérifications exécutent les vraies requêtes de la boutique, du bazar, du chat et du marché. Les écritures sont testées puis annulées : aucune donnée n'est modifiée.</p>`;
}

/* ------------------------------------------------------------------ */
/* Actions (clics et formulaires)                                      */
/* ------------------------------------------------------------------ */

async function patchUser(id, payload) {
  await api(`/api/admin/users/${id}`, { method: "PATCH", body: jsonBody(payload) });
}

const adminForms = {
  "user-email": async (form) => {
    const id = Number(form.dataset.id);
    await patchUser(id, { email: readFields(form).email });
    toast("E-mail mis à jour.", "success");
    await afterUserChange(id);
  },

  "user-balance": async (form) => {
    const id = Number(form.dataset.id);
    const { mode, amount } = readFields(form);
    await patchUser(id, { balance: { mode, amount } });
    toast("Solde mis à jour.", "success");
    await afterUserChange(id);
  },

  "user-role": async (form) => {
    const id = Number(form.dataset.id);
    await patchUser(id, { role: readFields(form).role });
    toast("Rôle mis à jour.", "success");
    await afterUserChange(id);
  },

  "user-mute": async (form) => {
    const id = Number(form.dataset.id);
    await patchUser(id, { muteMinutes: Number(readFields(form).minutes) });
    toast("Silence mis à jour.", "success");
    await afterUserChange(id);
  },

  "user-card": async (form) => {
    const id = Number(form.dataset.id);
    const { cardId, quantity } = readFields(form);
    await api(`/api/admin/users/${id}/grant`, {
      method: "POST",
      body: jsonBody({ type: "card", cardId: Number(cardId), quantity })
    });
    toast("Carte offerte.", "success");
  },

  "user-title": async (form) => {
    const id = Number(form.dataset.id);
    await api(`/api/admin/users/${id}/grant`, {
      method: "POST",
      body: jsonBody({ type: "title", titleId: Number(readFields(form).titleId) })
    });
    toast("Titre offert.", "success");
  },

  "pack-create": async (form) => {
    await api("/api/admin/packs", { method: "POST", body: jsonBody(readFields(form)) });
    toast("Pack créé.", "success");
    await loadAdminSection();
  },

  "market-event": async (form) => {
    const fields = readFields(form);
    const target = fields.symbol === "ALL" ? "toutes les entreprises" : fields.symbol;

    if (!confirm(`Appliquer ${fields.percent > 0 ? "+" : ""}${fields.percent} % à ${target} ?`)) return;

    const result = await api("/api/admin/market/event", {
      method: "POST",
      body: jsonBody({ symbol: fields.symbol, percent: fields.percent })
    });
    toast(`Événement appliqué à ${result.updated} entreprise(s).`, "success");
    await loadAdminSection();
  },

  "asset-create": async (form) => {
    const fields = readFields(form);
    fields.symbol = String(fields.symbol || "").toUpperCase();
    await api("/api/admin/assets", { method: "POST", body: jsonBody(fields) });
    toast("Entreprise ajoutée.", "success");
    await loadAdminSection();
  },

  "card-create": async (form) => {
    await api("/api/admin/cards", { method: "POST", body: jsonBody(readFields(form)) });
    toast("Carte créée.", "success");
    adminCardsCache = null;
    await loadAdminSection();
  },

  announcement: async (form) => {
    const result = await api("/api/admin/announcement", {
      method: "PUT",
      body: jsonBody({ text: readFields(form).text })
    });
    toast(result.text ? "Annonce publiée." : "Annonce retirée.", "success");
    loadAnnouncement();
  }
};

async function onAdminSubmit(event) {
  const form = event.target.closest("form[data-form]");
  if (!form) return;

  event.preventDefault();
  const handler = adminForms[form.dataset.form];
  if (!handler) return;

  const submit = $("button[type=submit]", form);
  setBusy(submit, true);

  try {
    await handler(form);
  } catch (error) {
    toastError(error);
  } finally {
    setBusy(submit, false);
  }
}

async function onAdminClick(event) {
  const button = event.target.closest("[data-admin]");
  if (!button) return;

  const action = button.dataset.admin;
  const row = button.closest("tr");
  const id = Number(button.dataset.id);

  try {
    if (action === "user-open") {
      await openUserModal(id);
    } else if (action === "user-ban") {
      const banned = button.dataset.banned !== "1";
      if (banned && !confirm("Suspendre ce compte ? Le joueur sera déconnecté.")) return;
      await patchUser(id, { banned });
      toast(banned ? "Compte suspendu." : "Compte réactivé.", "success");
      await afterUserChange(id);
    } else if (action === "user-delete") {
      if (!confirm("Supprimer définitivement ce compte et toutes ses données ?")) return;
      await api(`/api/admin/users/${id}`, { method: "DELETE" });
      toast("Compte supprimé.", "success");
      closeModal();
      await refreshAdminUsers();
    } else if (action === "restock") {
      await api("/api/admin/shop/restock", { method: "POST" });
      toast("Stocks renouvelés.", "success");
      await loadAdminSection();
    } else if (action === "pack-save") {
      setBusy(button, true);
      await api(`/api/admin/packs/${Number(row.dataset.id)}`, {
        method: "PATCH",
        body: jsonBody(readFields(row))
      });
      toast("Pack enregistré.", "success");
      setBusy(button, false);
    } else if (action === "asset-save") {
      setBusy(button, true);
      const fields = readFields(row);
      // On n'envoie le cours que s'il a vraiment été modifié.
      if (Number(fields.price) === Number(row.dataset.price)) delete fields.price;
      await api(`/api/admin/assets/${encodeURIComponent(row.dataset.symbol)}`, {
        method: "PATCH",
        body: jsonBody(fields)
      });
      toast("Entreprise enregistrée.", "success");
      setBusy(button, false);
    } else if (action === "card-save") {
      setBusy(button, true);
      await api(`/api/admin/cards/${Number(row.dataset.id)}`, {
        method: "PATCH",
        body: jsonBody(readFields(row))
      });
      adminCardsCache = null;
      toast("Carte enregistrée.", "success");
      setBusy(button, false);
    } else if (action === "event-preset") {
      const input = $('[data-field="percent"]', button.closest("form"));
      input.value = button.dataset.percent;
    } else if (action === "listing-cancel") {
      if (!confirm("Retirer cette annonce ? La carte retournera chez son vendeur.")) return;
      await api(`/api/admin/listings/${id}/cancel`, { method: "POST" });
      toast("Annonce retirée.", "success");
      await loadAdminSection();
    } else if (action === "diagnostic-run") {
      await loadAdminSection();
    } else if (action === "diagnostic-copy") {
      const text = diagnosticReport(lastDiagnostic);
      try {
        await navigator.clipboard.writeText(text);
        toast("Rapport copié dans le presse-papiers.", "success");
      } catch (error) {
        toast("Copie impossible : sélectionne le tableau et copie-le à la main.", "error");
      }
    } else if (action === "chat-clear") {
      if (!confirm("Supprimer tous les messages du chat ?")) return;
      const result = await api("/api/admin/chat/clear", { method: "POST" });
      toast(`${result.cleared} message(s) supprimé(s).`, "success");
    }
  } catch (error) {
    setBusy(button, false);
    toastError(error);
  }
}
