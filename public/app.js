"use strict";

const RANGES = ["1h", "6h", "24h", "3d"];
const RANGE_LABELS = { "1h": "1 h", "6h": "6 h", "24h": "24 h", "3d": "3 j" };

let marketTimer = null;
let announcementTimer = null;
let openCompanySymbol = null;
let currentTab = "market";

/* ------------------------------------------------------------------ */
/* Compte et navigation                                                */
/* ------------------------------------------------------------------ */

function currentPrice(symbol, fallback = 0) {
  const asset = state.assets.find((item) => item.symbol === symbol);
  return asset ? Number(asset.price) : Number(fallback || 0);
}

function holdingsValue() {
  return state.holdings.reduce(
    (sum, holding) => sum + Number(holding.quantity) * currentPrice(holding.symbol, holding.price),
    0
  );
}

function updateStats() {
  const balance = Number(state.user ? state.user.balance : 0);
  $("#balance").textContent = money(balance);
  $("#net-worth").textContent = money(balance + holdingsValue());
  $("#holding-count").textContent = state.holdings.length;
  $("#card-count").textContent = state.cards.reduce(
    (sum, card) => sum + Number(card.quantity || 0), 0
  );
  updateShopRows();
}

function renderAccount() {
  const connected = Boolean(state.user);

  $("#auth-panel").classList.add("hidden");
  $("#welcome-panel").classList.toggle("hidden", connected);
  $("#hero").classList.toggle("hidden", connected);
  $("#dashboard").classList.toggle("hidden", !connected);

  $("#account-area").innerHTML = connected
    ? `<span class="pill">${escapeHtml(state.user.username)}</span>${
        state.user.role === "admin" ? '<span class="pill admin">Admin</span>' : ""}`
    : `<button type="button" class="button secondary" id="show-login">Connexion</button>
       <button type="button" class="button primary" id="show-register">Créer un compte</button>`;

  if (connected) {
    $("#user-name").textContent = state.user.username;
    $("#admin-tab").classList.toggle("hidden", state.user.role !== "admin");
    updateStats();
  }
}

function showAuth(mode) {
  state.authMode = mode;
  const register = mode === "register";

  $("#auth-panel").classList.remove("hidden");
  $("#auth-title").textContent = register ? "Créer un compte" : "Connexion";
  $("#auth-submit").textContent = register ? "Créer mon compte" : "Se connecter";
  $("#email-field").classList.toggle("hidden", !register);
  $("#email").required = register;
  $("#password").autocomplete = register ? "new-password" : "current-password";
  $("#auth-message").textContent = "";
  $("#password").value = "";
  $("#username").focus();
}

function showTab(name, { load = true } = {}) {
  currentTab = name;

  $$(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.page === name));
  $$(".page-section").forEach((section) =>
    section.classList.toggle("hidden", section.id !== `page-${name}`)
  );

  if (name !== "chat") stopChat();
  if (!load) return;

  const loaders = {
    market: loadMarket,
    portfolio: loadPortfolio,
    shop: loadShop,
    collection: loadCollection,
    titles: loadTitles,
    bazaar: loadBazaar,
    friends: loadFriends,
    chat: startChat,
    admin: loadAdminPanel
  };

  const loader = loaders[name];
  if (loader) Promise.resolve(loader()).catch(toastError);
}

function resetState() {
  state.user = null;
  state.assets = [];
  state.holdings = [];
  state.cards = [];
  state.packs = [];
  state.titles = [];
  state.friends = { friends: [], incoming: [], outgoing: [] };
  state.bazaar.view = "buy";
  updateFriendsBadge();
}

function stopTimers() {
  clearInterval(marketTimer);
  marketTimer = null;
}

function startTimers() {
  stopTimers();

  marketTimer = setInterval(async () => {
    if (!state.user || document.hidden) return;

    try {
      await Promise.all([loadMarket(), loadPortfolio()]);
      loadFriends().catch(() => {});

      if (openCompanySymbol) {
        updateCompanyDynamic();
        loadCompanyChart();
      }
    } catch (error) {
      // Rafraîchissement automatique : on reste silencieux.
    }
  }, 30000);
}

function handleSessionExpired(message) {
  stopTimers();
  stopChat();
  closeModal(true);
  resetState();
  showTab("market", { load: false });
  renderAccount();
  toast(message, "error");
}

async function refreshAll() {
  const results = await Promise.allSettled([
    loadMarket(),
    loadPortfolio(),
    loadShop(),
    loadCollection(),
    loadTitles(),
    loadFriends()
  ]);

  const failure = results.find((result) => result.status === "rejected");
  if (failure) {
    toastError(failure.reason);
    return false;
  }

  updateStats();
  return true;
}

async function enterDashboard() {
  renderAccount();
  showTab("market", { load: false });
  startTimers();

  const ok = await refreshAll();
  ensureEmail();
  return ok;
}

/* ------------------------------------------------------------------ */
/* Annonce et e-mail obligatoire                                       */
/* ------------------------------------------------------------------ */

async function loadAnnouncement() {
  try {
    const data = await api("/api/announcement");
    const banner = $("#announcement");
    banner.textContent = data.text || "";
    banner.classList.toggle("hidden", !data.text);
  } catch (error) {
    // Pas d'annonce : on ne bloque rien.
  }
}

function ensureEmail() {
  if (!state.user || state.user.email) return;

  openModal(`
    <h2>Ajoute ton adresse e-mail</h2>
    <p class="muted">Une adresse e-mail valide est désormais obligatoire pour chaque compte.
    Renseigne la tienne pour continuer à jouer.</p>
    <form id="email-form" class="stack">
      <label for="email-input">Adresse e-mail</label>
      <input id="email-input" type="email" required maxlength="254" autocomplete="email" placeholder="prenom.nom@exemple.fr">
      <button type="submit" class="button primary full">Enregistrer</button>
      <button type="button" class="button secondary full" id="email-logout">Se déconnecter</button>
      <p id="email-message" class="message error" role="alert"></p>
    </form>`, { locked: true });

  $("#email-input").focus();

  $("#email-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = $("button[type=submit]", event.target);
    setBusy(submit, true);

    try {
      const result = await api("/api/me/email", {
        method: "PATCH",
        body: jsonBody({ email: $("#email-input").value })
      });
      state.user.email = result.email;
      closeModal(true);
      toast("Adresse e-mail enregistrée.", "success");
    } catch (error) {
      $("#email-message").textContent = error.message;
      setBusy(submit, false);
    }
  });

  $("#email-logout").addEventListener("click", () => {
    closeModal(true);
    logout();
  });
}

/* ------------------------------------------------------------------ */
/* Marché                                                              */
/* ------------------------------------------------------------------ */

function filteredAssets() {
  const { search, sector, sort } = state.marketFilter;
  const query = search.trim().toLowerCase();

  const list = state.assets.filter((asset) =>
    (!sector || asset.sector === sector) &&
    (!query ||
      asset.name.toLowerCase().includes(query) ||
      asset.symbol.toLowerCase().includes(query))
  );

  const sorters = {
    name: (a, b) => a.name.localeCompare(b.name, "fr"),
    "price-desc": (a, b) => Number(b.price) - Number(a.price),
    "price-asc": (a, b) => Number(a.price) - Number(b.price),
    up: (a, b) => b.changePct - a.changePct,
    down: (a, b) => a.changePct - b.changePct
  };

  return list.sort(sorters[sort] || sorters.name);
}

function renderSectorOptions() {
  const select = $("#market-sector");
  const sectors = [...new Set(state.assets.map((asset) => asset.sector))]
    .sort((a, b) => a.localeCompare(b, "fr"));
  const signature = sectors.join("|");

  if (select.dataset.signature === signature) return;

  select.dataset.signature = signature;
  select.innerHTML = '<option value="">Tous les secteurs</option>' +
    sectors.map((sector) =>
      `<option value="${escapeHtml(sector)}">${escapeHtml(sector)}</option>`
    ).join("");
  select.value = sectors.includes(state.marketFilter.sector) ? state.marketFilter.sector : "";
}

function assetCard(asset) {
  const holding = state.holdings.find((item) => item.symbol === asset.symbol);

  return `<article class="asset-card" role="button" tabindex="0" data-symbol="${escapeHtml(asset.symbol)}"
      aria-label="Voir ${escapeHtml(asset.name)}">
    <div class="asset-top">
      ${companyLogo(asset, 46)}
      <div class="asset-id">
        <strong>${escapeHtml(asset.name)}</strong>
        <span class="muted">${escapeHtml(asset.symbol)} · ${escapeHtml(asset.sector)}</span>
      </div>
      ${holding ? '<span class="pill owned">Détenu</span>' : ""}
    </div>
    <div class="asset-spark">${sparkline(asset.spark)}</div>
    <div class="asset-bottom">
      <span class="price">${fmtPrice(asset.price)}</span>
      <span class="change ${trendClass(asset.changePct)}">${fmtPct(asset.changePct)}</span>
    </div>
  </article>`;
}

function renderMarket() {
  renderSectorOptions();
  const list = filteredAssets();

  $("#market-count").textContent = `${list.length} entreprise${list.length > 1 ? "s" : ""}`;
  $("#market-list").innerHTML = list.length
    ? list.map(assetCard).join("")
    : '<p class="muted">Aucune entreprise ne correspond à ta recherche.</p>';
}

async function loadMarket() {
  const data = await api("/api/market");
  state.assets = Array.isArray(data.assets) ? data.assets : [];
  renderMarket();
  if (state.user) updateStats();
}

/* ----- Fiche entreprise ----- */

function companyModalHtml(asset) {
  return `
    <div class="company-head">
      ${companyLogo(asset, 64)}
      <div class="company-title">
        <h2>${escapeHtml(asset.name)}</h2>
        <div class="company-sub">
          <span class="pill">${escapeHtml(asset.symbol)}</span>
          <span class="pill">${escapeHtml(asset.sector)}</span>
        </div>
      </div>
      <div class="company-price">
        <strong id="co-price"></strong>
        <span id="co-change" class="change"></span>
      </div>
    </div>

    <div class="range-tabs" id="co-ranges" role="group" aria-label="Période du graphique">
      ${RANGES.map((range) =>
        `<button type="button" class="chip${range === state.range ? " active" : ""}" data-range="${range}">${RANGE_LABELS[range]}</button>`
      ).join("")}
    </div>
    <div id="co-chart" class="chart-wrap"><p class="muted chart-empty">Chargement du graphique…</p></div>
    <div id="co-stats" class="range-stats"></div>

    ${asset.description ? `<p class="company-desc">${escapeHtml(asset.description)}</p>` : ""}

    <div class="trade-box">
      <div id="co-holding" class="trade-holding"></div>
      <label for="co-qty">Quantité</label>
      <div class="qty-row">
        <input id="co-qty" type="number" min="0.001" max="1000000" step="0.001" value="1" inputmode="decimal">
        <div class="quick">
          <button type="button" class="chip" data-qty="1">1</button>
          <button type="button" class="chip" data-qty="10">10</button>
          <button type="button" class="chip" data-qty="100">100</button>
          <button type="button" class="chip" data-qty="max-buy">Max achat</button>
          <button type="button" class="chip" data-qty="max-sell">Tout vendre</button>
        </div>
      </div>
      <div id="co-estimate" class="trade-estimate"></div>
      <div class="trade-actions">
        <button type="button" class="button primary" id="co-buy">Acheter</button>
        <button type="button" class="button secondary" id="co-sell">Vendre</button>
      </div>
    </div>`;
}

function openCompany(symbol) {
  const asset = state.assets.find((item) => item.symbol === symbol);
  if (!asset) {
    toast("Entreprise introuvable. Recharge la page puis réessaie.", "error");
    return;
  }

  openCompanySymbol = symbol;

  openModal(companyModalHtml(asset), {
    wide: true,
    onClose: () => { openCompanySymbol = null; }
  });

  $("#co-ranges").addEventListener("click", (event) => {
    const button = event.target.closest("[data-range]");
    if (!button) return;

    state.range = button.dataset.range;
    $$("#co-ranges .chip").forEach((chip) =>
      chip.classList.toggle("active", chip === button)
    );
    loadCompanyChart();
  });

  $(".quick").addEventListener("click", (event) => {
    const button = event.target.closest("[data-qty]");
    if (!button) return;

    const price = currentPrice(openCompanySymbol);
    const holding = state.holdings.find((item) => item.symbol === openCompanySymbol);
    const mode = button.dataset.qty;
    let quantity = Number(mode);

    if (mode === "max-buy") {
      quantity = price > 0 ? Math.floor((Number(state.user.balance) / price) * 1000) / 1000 : 0;
    } else if (mode === "max-sell") {
      quantity = holding ? Number(holding.quantity) : 0;
    }

    $("#co-qty").value = quantity > 0 ? String(quantity) : "";
    updateCompanyDynamic();
  });

  $("#co-qty").addEventListener("input", updateCompanyDynamic);
  $("#co-buy").addEventListener("click", () => submitTrade("buy"));
  $("#co-sell").addEventListener("click", () => submitTrade("sell"));

  updateCompanyDynamic();
  loadCompanyChart();
}

function updateCompanyDynamic() {
  if (!openCompanySymbol || !$("#co-price")) return;

  const asset = state.assets.find((item) => item.symbol === openCompanySymbol);
  if (!asset) return;

  const price = Number(asset.price);
  $("#co-price").textContent = fmtPrice(price);

  const change = $("#co-change");
  change.textContent = `${fmtPct(asset.changePct)} sur 24 h`;
  change.className = `change ${trendClass(asset.changePct)}`;

  const holding = state.holdings.find((item) => item.symbol === openCompanySymbol);
  if (holding) {
    const quantity = Number(holding.quantity);
    const average = Number(holding.average_price);
    const value = quantity * price;
    const gain = average > 0 ? ((price - average) / average) * 100 : 0;

    $("#co-holding").innerHTML =
      `Tu possèdes <strong>${fmtQty(quantity)}</strong> titre(s) · valeur ${money(value)} ·
       prix moyen ${fmtPrice(average)} ·
       <span class="change ${trendClass(gain)}">${fmtPct(gain)}</span>`;
  } else {
    $("#co-holding").textContent = "Tu ne possèdes pas encore ce titre.";
  }

  const quantity = Number($("#co-qty").value);
  const total = Number.isFinite(quantity) && quantity > 0 ? quantity * price : 0;
  $("#co-estimate").innerHTML = total > 0
    ? `Montant estimé : <strong>${money(total)}</strong> · Solde : ${money(state.user.balance)}`
    : `Solde : ${money(state.user.balance)}`;
}

async function loadCompanyChart() {
  const symbol = openCompanySymbol;
  const range = state.range;
  if (!symbol || !$("#co-chart")) return;

  try {
    const data = await api(`/api/market/${encodeURIComponent(symbol)}/history?range=${range}`);

    // La fiche a pu être fermée ou changée pendant le chargement.
    const box = $("#co-chart");
    if (!box || symbol !== openCompanySymbol || range !== state.range) return;

    renderLineChart(box, data.points, { range });

    const prices = data.points.map((point) => point.p);
    if (prices.length) {
      const first = prices[0];
      const last = prices[prices.length - 1];
      const variation = first > 0 ? ((last - first) / first) * 100 : 0;

      $("#co-stats").innerHTML = `
        <div><span>Ouverture</span><strong>${fmtPrice(first)}</strong></div>
        <div><span>Plus haut</span><strong>${fmtPrice(Math.max(...prices))}</strong></div>
        <div><span>Plus bas</span><strong>${fmtPrice(Math.min(...prices))}</strong></div>
        <div><span>Variation</span><strong class="change ${trendClass(variation)}">${fmtPct(variation)}</strong></div>`;
    }
  } catch (error) {
    const box = $("#co-chart");
    if (box) box.innerHTML = `<p class="muted chart-empty">${escapeHtml(error.message)}</p>`;
  }
}

async function executeTrade(symbol, side, quantity) {
  const result = await api("/api/trade", {
    method: "POST",
    body: jsonBody({ symbol, quantity, side })
  });

  state.user.balance = result.balance;
  toast(
    `${side === "buy" ? "Achat" : "Vente"} effectué : ${fmtQty(result.quantity)} × ${symbol} pour ${money(result.total)}.`,
    "success"
  );
  toastTitles(result.newTitles);

  await Promise.allSettled([loadMarket(), loadPortfolio()]);
  if (result.newTitles && result.newTitles.length) loadTitles().catch(() => {});
  updateStats();
  return result;
}

async function submitTrade(side) {
  const symbol = openCompanySymbol;
  const quantity = Number($("#co-qty").value);

  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1000000) {
    return toast("Saisis une quantité valide.", "error");
  }

  const buttons = [$("#co-buy"), $("#co-sell")];
  buttons.forEach((button) => setBusy(button, true));

  try {
    await executeTrade(symbol, side, quantity);
    updateCompanyDynamic();
  } catch (error) {
    toastError(error);
  } finally {
    buttons.forEach((button) => setBusy(button, false));
  }
}

/* ------------------------------------------------------------------ */
/* Portefeuille                                                        */
/* ------------------------------------------------------------------ */

async function loadPortfolio() {
  const data = await api("/api/portfolio");
  state.holdings = Array.isArray(data.holdings) ? data.holdings : [];
  if (state.user) state.user.balance = data.balance;

  renderPortfolio();
  renderMarket();
  updateStats();
}

function renderPortfolio() {
  if (!state.user) return;

  const cash = Number(state.user.balance);
  const rows = state.holdings.map((holding) => {
    const quantity = Number(holding.quantity);
    const average = Number(holding.average_price);
    const price = currentPrice(holding.symbol, holding.price);
    const value = quantity * price;
    const cost = quantity * average;

    return {
      ...holding,
      quantity,
      average,
      price,
      value,
      cost,
      pnl: value - cost,
      pct: cost > 0 ? ((value - cost) / cost) * 100 : 0,
      name: holding.name || holding.symbol
    };
  });

  const invested = rows.reduce((sum, row) => sum + row.value, 0);
  const cost = rows.reduce((sum, row) => sum + row.cost, 0);
  const pnl = invested - cost;
  const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0;

  $("#portfolio-summary").innerHTML = `
    <article class="stat-card"><span>Liquidités</span><strong>${money(cash)}</strong><small>Disponible</small></article>
    <article class="stat-card"><span>Valeur des actifs</span><strong>${money(invested)}</strong><small>${rows.length} ligne(s)</small></article>
    <article class="stat-card"><span>Patrimoine total</span><strong>${money(cash + invested)}</strong><small>Liquidités + actifs</small></article>
    <article class="stat-card"><span>Gain / perte latent</span><strong class="${trendClass(pnl)}">${money(pnl)}</strong><small class="${trendClass(pnl)}">${fmtPct(pnlPct)}</small></article>`;

  const slices = rows.map((row) => ({
    label: row.name,
    value: row.value,
    color: safeColor(row.color)
  }));
  slices.push({ label: "Liquidités", value: cash, color: "#64748b" });

  $("#portfolio-donut").innerHTML = renderDonut(slices, {
    title: "Patrimoine",
    value: money(cash + invested).replace(" crédits", "")
  });

  $("#portfolio-table").innerHTML = rows.length
    ? `<div class="table-wrap"><table class="data-table">
        <thead><tr>
          <th>Entreprise</th><th>Quantité</th><th>Prix moyen</th><th>Cours</th>
          <th>Valeur</th><th>Gain / perte</th><th></th>
        </tr></thead>
        <tbody>${rows.map((row) => `<tr>
          <td><div class="cell-company">${companyLogo(row, 32)}<div><strong>${escapeHtml(row.name)}</strong><br><span class="muted">${escapeHtml(row.symbol)}</span></div></div></td>
          <td>${fmtQty(row.quantity)}</td>
          <td>${fmtPrice(row.average)}</td>
          <td>${fmtPrice(row.price)}</td>
          <td>${money(row.value)}</td>
          <td class="${trendClass(row.pnl)}">${money(row.pnl)}<br><small>${fmtPct(row.pct)}</small></td>
          <td class="actions">
            <button type="button" class="button secondary small" data-view="${escapeHtml(row.symbol)}">Voir</button>
            <button type="button" class="button secondary small" data-sellall="${escapeHtml(row.symbol)}">Tout vendre</button>
          </td>
        </tr>`).join("")}</tbody></table></div>`
    : `<div class="empty-state"><p>Tu ne possèdes encore aucune action.</p>
        <button type="button" class="button primary" id="go-market">Découvrir le marché</button></div>`;
}

/* ------------------------------------------------------------------ */
/* Boutique                                                            */
/* ------------------------------------------------------------------ */

let shopInfo = { nextRestockAt: null, offset: 0, maxAutoStock: 25, lastReload: 0 };
const shopQty = {};

function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = String(Math.floor(total / 60)).padStart(2, "0");
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function updateShopCountdown() {
  const element = $("#shop-countdown");
  if (!element || !shopInfo.nextRestockAt) return;

  const remaining = new Date(shopInfo.nextRestockAt).getTime() - (Date.now() + shopInfo.offset);

  if (remaining > 0) {
    element.textContent = formatCountdown(remaining);
    return;
  }

  element.textContent = "00:00";

  // Le stock vient d'être renouvelé : on recharge (au plus toutes les 5 secondes).
  if (state.user && Date.now() - shopInfo.lastReload > 5000) {
    shopInfo.lastReload = Date.now();
    loadShop().catch(() => {});
  }
}

function oddsBar(pack) {
  return RARITY_ORDER
    .filter((key) => Number(pack.odds[key]) > 0)
    .map((key) =>
      `<span style="width:${Number(pack.odds[key])}%;background:${RARITY[key].color}" title="${RARITY[key].label} : ${String(pack.odds[key]).replace(".", ",")} %"></span>`
    ).join("");
}

function packCard(pack) {
  const stock = Number(pack.stock) || 0;
  const percent = Math.min(100, Math.round((stock / shopInfo.maxAutoStock) * 100));

  const odds = RARITY_ORDER
    .filter((key) => Number(pack.odds[key]) > 0)
    .map((key) =>
      `<li><span class="dot" style="background:${RARITY[key].color}"></span>${RARITY[key].label}<strong>${String(pack.odds[key]).replace(".", ",")} %</strong></li>`
    ).join("");

  const guarantee = pack.guarantee
    ? `<p class="guarantee">★ 1 carte ${RARITY[pack.guarantee].label.toLowerCase()} minimum garantie</p>`
    : "";

  return `<article class="shop-card tier-${escapeHtml(pack.tier)}" data-pack-id="${Number(pack.id)}">
    <div class="pack-visual">${packArt(pack)}</div>
    <h3>${escapeHtml(pack.name)}</h3>
    <p>${escapeHtml(pack.description)}</p>
    ${guarantee}
    <div class="odds-bar" aria-hidden="true">${oddsBar(pack)}</div>
    <ul class="odds">${odds}</ul>
    <div class="stock-line">
      <div class="progress"><span style="width:${percent}%"></span></div>
      <small class="muted">Stock : ${stock}</small>
    </div>
    <div class="price">${money(pack.price)}</div>
    <div class="buy-row">
      <div class="stepper" role="group" aria-label="Nombre de packs">
        <button type="button" data-step="-1" aria-label="Un pack de moins">−</button>
        <output class="qty-value">1</output>
        <button type="button" data-step="1" aria-label="Un pack de plus">+</button>
      </div>
      <strong class="buy-total"></strong>
    </div>
    <button type="button" class="button primary full buy-button" data-buy-pack="${Number(pack.id)}">Acheter</button>
    <small class="buy-hint muted"></small>
  </article>`;
}

// Recalcule quantité, prix total et messages selon le solde et le stock.
function updateShopRows() {
  if (!state.user) return;
  const balance = Number(state.user.balance);

  $$("#shop-list .shop-card").forEach((card) => {
    const pack = state.packs.find((item) => item.id === Number(card.dataset.packId));
    const button = $(".buy-button", card);
    if (!pack || button.dataset.busy) return;

    const stock = Number(pack.stock) || 0;
    const price = Number(pack.price);
    const affordable = price > 0 ? Math.floor(balance / price) : 10;
    const maxQty = Math.max(0, Math.min(10, stock, affordable));
    const qty = Math.min(Math.max(shopQty[pack.id] || 1, 1), Math.max(maxQty, 1));
    shopQty[pack.id] = qty;

    $(".qty-value", card).textContent = qty;
    const [minus, plus] = $$(".stepper button", card);
    minus.disabled = qty <= 1;
    plus.disabled = qty >= maxQty;

    const hint = $(".buy-hint", card);
    $(".buy-total", card).textContent = money(price * qty);

    if (stock <= 0) {
      button.disabled = true;
      button.textContent = "Rupture de stock";
      hint.textContent = "Reviens après le prochain réapprovisionnement.";
    } else if (maxQty < 1) {
      button.disabled = true;
      button.textContent = "Solde insuffisant";
      hint.textContent = `Il te manque ${money(price - balance)}.`;
    } else {
      button.disabled = false;
      button.textContent = qty > 1 ? `Acheter ×${qty}` : "Acheter";
      hint.textContent = stock <= 3 ? `Plus que ${stock} en stock !` : "";
    }
  });
}

async function loadShop() {
  const data = await api("/api/shop");
  state.packs = Array.isArray(data.packs) ? data.packs : [];

  shopInfo = {
    nextRestockAt: data.nextRestockAt || null,
    offset: data.serverTime ? new Date(data.serverTime).getTime() - Date.now() : 0,
    maxAutoStock: Number(data.maxAutoStock) || 25,
    lastReload: Date.now()
  };

  $("#shop-bar").innerHTML = `
    <span>Prochain réapprovisionnement dans <strong id="shop-countdown">--:--</strong></span>
    <span class="muted">Chaque réapprovisionnement ajoute de 1 à 8 packs, jusqu'à ${shopInfo.maxAutoStock} par pack.</span>`;

  $("#shop-list").innerHTML = state.packs.length
    ? state.packs.map(packCard).join("")
    : "<p>La boutique est vide pour le moment.</p>";

  updateShopRows();
  updateShopCountdown();
}

async function buyPack(packId, quantity, button) {
  const pack = state.packs.find((item) => item.id === packId);
  if (!pack) return;

  button.dataset.busy = "1";
  setBusy(button, true);

  try {
    const result = await api("/api/shop/buy", {
      method: "POST",
      body: jsonBody({ packId, quantity })
    });

    state.user.balance = result.balance;
    delete button.dataset.busy;
    updateStats();
    toastTitles(result.newTitles);
    openPackReveal(pack, result);

    // Met à jour le stock affiché derrière la fenêtre d'ouverture.
    loadShop().catch(() => {});
  } catch (error) {
    toastError(error);
    delete button.dataset.busy;
    setBusy(button, false);

    // Le stock ou le solde a pu changer : on remet l'affichage à jour.
    loadShop().catch(() => {});
    api("/api/me").then((data) => {
      if (data.user && state.user) {
        state.user.balance = data.user.balance;
        updateStats();
      }
    }).catch(() => {});
  }
}

function openPackReveal(pack, result) {
  const openings = result.openings && result.openings.length ? result.openings : [result.cards || []];
  const multiple = openings.length > 1;
  const total = openings.reduce((sum, list) => sum + list.length, 0);
  let revealed = 0;

  openModal(`
    <div class="reveal">
      <h2>${escapeHtml(pack.emoji)} ${escapeHtml(pack.name)}${multiple ? ` ×${openings.length}` : ""}</h2>
      <p class="muted">Clique sur les cartes pour les retourner.</p>
      ${openings.map((cards, o) => `
        ${multiple ? `<h3 class="opening-title">Pack n° ${o + 1}</h3>` : ""}
        <div class="reveal-grid">
          ${cards.map((card, index) => `
            <div class="reveal-card" data-opening="${o}" data-index="${index}" tabindex="0" role="button" aria-label="Retourner la carte ${index + 1}">
              <div class="flip">
                <div class="face back">${cardBack()}</div>
                <div class="face front">
                  ${cardTile(card, { isNew: card.isNew })}
                  <div class="reveal-name">${escapeHtml(RARITY[rarityOf(card)].label)}</div>
                </div>
              </div>
            </div>`).join("")}
        </div>`).join("")}
      <div id="reveal-summary" class="reveal-summary hidden"></div>
      <div class="reveal-actions">
        <button type="button" class="button primary" id="reveal-all">Tout révéler</button>
        <button type="button" class="button secondary" id="reveal-done">Terminer</button>
      </div>
    </div>`, {
    wide: true,
    onClose: () => {
      Promise.allSettled([loadShop(), loadCollection()]).then(updateStats);
    }
  });

  const showSummary = () => {
    const all = openings.flat();
    const byRarity = RARITY_ORDER.map((key) => ({
      key,
      count: all.filter((card) => rarityOf(card) === key).length
    })).filter((item) => item.count > 0);
    const fresh = all.filter((card) => card.isNew).length;

    const box = $("#reveal-summary");
    if (!box) return;
    box.innerHTML = `
      <strong>${total} carte${total > 1 ? "s" : ""}</strong> obtenue${total > 1 ? "s" : ""}
      dont <strong>${fresh}</strong> nouvelle${fresh > 1 ? "s" : ""}
      · dépensé : ${money(result.spent ?? pack.price)}
      <div class="rarity-pills">${byRarity.map((item) =>
        `<span class="pill" style="border-color:${RARITY[item.key].color};color:${RARITY[item.key].color}">${RARITY[item.key].label} ×${item.count}</span>`
      ).join("")}</div>`;
    box.classList.remove("hidden");
  };

  const flip = (element) => {
    if (element.classList.contains("flipped")) return;
    const card = openings[Number(element.dataset.opening)][Number(element.dataset.index)];
    element.classList.add("flipped", `glow-${rarityOf(card)}`);
    revealed += 1;
    if (revealed === total) showSummary();
  };

  $$(".reveal-card").forEach((element) => {
    element.addEventListener("click", () => flip(element));
    element.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        flip(element);
      }
    });
  });

  $("#reveal-all").addEventListener("click", () => {
    const delay = multiple ? 120 : 350;
    $$(".reveal-card").forEach((element, i) => setTimeout(() => flip(element), i * delay));
  });
  $("#reveal-done").addEventListener("click", () => closeModal());
}

/* ------------------------------------------------------------------ */
/* Collection                                                          */
/* ------------------------------------------------------------------ */

function filteredCards() {
  const { search, rarity, ownedOnly } = state.collectionFilter;
  const query = search.trim().toLowerCase();

  return state.cards.filter((card) => {
    const owned = Number(card.quantity) > 0;
    if (ownedOnly && !owned) return false;
    if (rarity && card.rarityKey !== rarity) return false;
    // Une carte non découverte ne peut pas être trouvée par son nom.
    if (query && !(owned && card.name.toLowerCase().includes(query))) return false;
    return true;
  });
}

function renderCollection() {
  const total = state.cards.length;
  const discovered = state.cards.filter((card) => Number(card.quantity) > 0).length;
  const percent = total ? Math.round((discovered / total) * 100) : 0;

  const byRarity = RARITY_ORDER.map((key) => {
    const all = state.cards.filter((card) => card.rarityKey === key);
    const own = all.filter((card) => Number(card.quantity) > 0).length;
    return all.length
      ? `<span class="pill" style="border-color:${RARITY[key].color};color:${RARITY[key].color}">${RARITY[key].label} ${own}/${all.length}</span>`
      : "";
  }).join("");

  $("#collection-progress").innerHTML = `
    <div class="progress-line"><strong>${discovered} / ${total}</strong> cartes découvertes (${percent} %)</div>
    <div class="progress"><span style="width:${percent}%"></span></div>
    <div class="rarity-pills">${byRarity}</div>`;

  const list = filteredCards();
  $("#collection-list").innerHTML = list.length
    ? list.map((card) => {
        const quantity = Number(card.quantity);
        return `<button type="button" class="collect-card" data-card="${escapeHtml(card.id)}"
          aria-label="${quantity > 0 ? escapeHtml(card.name) : "Carte non découverte"}">
          ${cardTile(card, { locked: quantity === 0, quantity })}
        </button>`;
      }).join("")
    : '<p class="muted">Aucune carte ne correspond à ces filtres.</p>';
}

async function loadCollection() {
  const data = await api("/api/cards");
  state.cards = Array.isArray(data.cards) ? data.cards : [];
  renderCollection();
  if (state.user) updateStats();
}

function openCardDetail(cardId) {
  const card = state.cards.find((item) => String(item.id) === String(cardId));
  if (!card) {
    toast("Carte introuvable. Recharge la page puis réessaie.", "error");
    return;
  }

  const quantity = Number(card.quantity);
  const key = rarityOf(card);

  openModal(`
    <div class="card-detail">
      <div class="card-detail-art">${cardTile(card, { locked: quantity === 0, quantity })}</div>
      <div class="card-detail-info">
        <h2>${quantity > 0 ? escapeHtml(card.name) : "Carte non découverte"}</h2>
        <p><span class="pill" style="border-color:${RARITY[key].color};color:${RARITY[key].color}">${RARITY[key].label}</span>
          ${card.series ? `<span class="pill">${escapeHtml(card.series)}</span>` : ""}</p>
        <p>${quantity > 0 ? escapeHtml(card.description) : "Ouvre des packs pour découvrir cette carte."}</p>
        <p class="muted">${quantity > 0 ? `Tu possèdes ${quantity} exemplaire${quantity > 1 ? "s" : ""}.` : "Tu ne la possèdes pas encore."}</p>
      </div>
    </div>`);
}

/* ------------------------------------------------------------------ */
/* Titres                                                              */
/* ------------------------------------------------------------------ */

async function loadTitles() {
  const data = await api("/api/titles");
  state.titles = Array.isArray(data.titles) ? data.titles : [];

  const unlocked = state.titles.filter((title) => title.unlocked).length;

  $("#titles-list").innerHTML = state.titles.length
    ? `<p class="muted titles-count">${unlocked} / ${state.titles.length} titres débloqués</p>` +
      state.titles.map((title) => `
        <article class="title-card${title.unlocked ? " unlocked" : ""}">
          <div class="card-art">${title.unlocked ? "🏅" : "🔒"}</div>
          <h3>${escapeHtml(title.name)}</h3>
          <p>${escapeHtml(title.description)}</p>
          <span class="pill">${title.unlocked ? "Débloqué" : "À débloquer"}</span>
        </article>`).join("")
    : "<p>Aucun titre disponible.</p>";
}

/* ------------------------------------------------------------------ */
/* Connexion, inscription, déconnexion                                 */
/* ------------------------------------------------------------------ */

async function logout() {
  try {
    await api("/api/logout", { method: "POST" });
    stopTimers();
    stopChat();
    closeModal(true);
    resetState();
    showTab("market", { load: false });
    renderAccount();
    toast("Tu es déconnecté.");
  } catch (error) {
    toastError(error);
  }
}

function setupEvents() {
  setupModal();

  $("#account-area").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.id === "show-login") showAuth("login");
    if (button.id === "show-register") showAuth("register");
  });

  $("#close-auth").addEventListener("click", () => $("#auth-panel").classList.add("hidden"));

  $("#auth-form").addEventListener("submit", async (event) => {
    event.preventDefault();

    const submit = $("#auth-submit");
    const register = state.authMode === "register";
    const payload = {
      username: $("#username").value.trim(),
      password: $("#password").value
    };
    if (register) payload.email = $("#email").value.trim();

    setBusy(submit, true);

    try {
      const result = await api(register ? "/api/register" : "/api/login", {
        method: "POST",
        body: jsonBody(payload)
      });

      state.user = result.user;
      $("#password").value = "";
      $("#auth-message").textContent = "";

      const loaded = await enterDashboard();
      if (loaded) toast("Bienvenue sur Sigma Exchange !", "success");
    } catch (error) {
      $("#auth-message").textContent = error.message;
    } finally {
      setBusy(submit, false);
    }
  });

  $("#logout").addEventListener("click", logout);

  $$(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      if (!tab.classList.contains("hidden")) showTab(tab.dataset.page);
    });
  });

  // Marché
  $("#market-search").addEventListener("input", (event) => {
    state.marketFilter.search = event.target.value;
    renderMarket();
  });
  $("#market-sector").addEventListener("change", (event) => {
    state.marketFilter.sector = event.target.value;
    renderMarket();
  });
  $("#market-sort").addEventListener("change", (event) => {
    state.marketFilter.sort = event.target.value;
    renderMarket();
  });

  const openFromCard = (event) => {
    const card = event.target.closest("[data-symbol]");
    if (card) openCompany(card.dataset.symbol);
  };
  $("#market-list").addEventListener("click", openFromCard);
  $("#market-list").addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openFromCard(event);
    }
  });

  // Portefeuille
  $("#portfolio-table").addEventListener("click", async (event) => {
    const view = event.target.closest("[data-view]");
    const sellAll = event.target.closest("[data-sellall]");

    if (event.target.closest("#go-market")) return showTab("market");
    if (view) return openCompany(view.dataset.view);

    if (sellAll) {
      const symbol = sellAll.dataset.sellall;
      const holding = state.holdings.find((item) => item.symbol === symbol);
      if (!holding) return;

      if (!confirm(`Vendre toute ta position en ${symbol} au cours actuel ?`)) return;

      setBusy(sellAll, true);
      try {
        await executeTrade(symbol, "sell", Number(holding.quantity));
      } catch (error) {
        toastError(error);
        setBusy(sellAll, false);
      }
    }
  });

  // Boutique
  $("#shop-list").addEventListener("click", (event) => {
    const step = event.target.closest("[data-step]");
    const buy = event.target.closest("[data-buy-pack]");

    if (step) {
      const card = step.closest(".shop-card");
      const id = Number(card.dataset.packId);
      shopQty[id] = (shopQty[id] || 1) + Number(step.dataset.step);
      updateShopRows();
    } else if (buy) {
      const id = Number(buy.dataset.buyPack);
      buyPack(id, shopQty[id] || 1, buy);
    }
  });
  setInterval(updateShopCountdown, 1000);

  // Collection
  $("#collection-search").addEventListener("input", (event) => {
    state.collectionFilter.search = event.target.value;
    renderCollection();
  });
  $("#collection-rarity").addEventListener("change", (event) => {
    state.collectionFilter.rarity = event.target.value;
    renderCollection();
  });
  $("#collection-owned").addEventListener("change", (event) => {
    state.collectionFilter.ownedOnly = event.target.checked;
    renderCollection();
  });
  $("#collection-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-card]");
    if (button) openCardDetail(button.dataset.card);
  });

  setupChat();
  setupBazaar();
  setupFriends();
  setupAdmin();
}

async function init() {
  setupEvents();

  loadAnnouncement();
  announcementTimer = setInterval(() => {
    if (!document.hidden) loadAnnouncement();
  }, 60000);

  try {
    const data = await api("/api/me");
    if (data.user) {
      state.user = data.user;
      await enterDashboard();
    } else {
      renderAccount();
    }
  } catch (error) {
    console.error("Initialisation :", error);
    renderAccount();
    toast(error.message || "Impossible de charger le site. Vérifie le serveur.", "error");
  }
}

document.addEventListener("DOMContentLoaded", init);
