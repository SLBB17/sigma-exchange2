"use strict";

// Prix conseillés par rareté quand personne ne vend encore la carte.
const SUGGESTED_PRICE = { common: 20, rare: 60, epic: 200, legendary: 800, mythic: 3000 };
const BAZAAR_VIEWS = [["buy", "Acheter"], ["mine", "Mes annonces"], ["sell", "Vendre une carte"]];

let bazaarCards = [];
let bazaarMine = { active: [], history: [], feeRate: 0.05 };

function showBazaarView() {
  const view = state.bazaar.view;

  $$("#bazaar-nav .chip").forEach((chip) =>
    chip.classList.toggle("active", chip.dataset.view === view)
  );
  $("#bazaar-buy").classList.toggle("hidden", view !== "buy");
  $("#bazaar-mine").classList.toggle("hidden", view !== "mine");
  $("#bazaar-sell").classList.toggle("hidden", view !== "sell");
}

async function loadBazaar() {
  showBazaarView();

  const view = state.bazaar.view;
  if (view === "buy") return loadBazaarListings();
  if (view === "mine") return loadMyListings();

  if (!state.cards.length) await loadCollection();
  renderSellGrid();
}

async function refreshCardData() {
  await Promise.allSettled([loadCollection(), loadTitles()]);
  updateStats();
}

/* ------------------------------------------------------------------ */
/* Acheter : une ligne par carte                                       */
/* ------------------------------------------------------------------ */

function cardMarketTile(entry) {
  const { card, floor, count, mineCount } = entry;

  return `<article class="listing">
    <button type="button" class="listing-art" data-market="${escapeHtml(card.id)}" aria-label="Voir les offres pour ${escapeHtml(card.name)}">${cardTile(card)}</button>
    <div class="listing-info">
      <strong class="listing-price">dès ${money(floor)}</strong>
      <span class="muted">${count} offre${count > 1 ? "s" : ""}${mineCount ? ` · dont ${mineCount} à toi` : ""}</span>
    </div>
    <button type="button" class="button primary small full" data-market="${escapeHtml(card.id)}">Voir les offres</button>
  </article>`;
}

async function loadBazaarListings() {
  const filter = state.bazaar.filter;
  const params = new URLSearchParams({
    q: filter.search.trim(),
    rarity: filter.rarity,
    seller: filter.seller,
    sort: filter.sort
  });

  const data = await api(`/api/bazaar/cards?${params}`);
  bazaarCards = Array.isArray(data.cards) ? data.cards : [];

  $("#bazaar-count").textContent =
    `${data.total} carte${data.total > 1 ? "s" : ""} · ${data.totalListings} offre${data.totalListings > 1 ? "s" : ""}`;
  $("#bazaar-list").innerHTML = bazaarCards.length
    ? bazaarCards.map(cardMarketTile).join("")
    : '<p class="muted">Aucune offre ne correspond. Sois le premier à vendre une carte !</p>';
}

/* ----- Fiche de marché d'une carte ----- */

function offerRow(item, floor) {
  const price = Number(item.price);
  const diff = floor > 0 ? ((price - floor) / floor) * 100 : 0;

  return `<tr>
    <td><strong>${escapeHtml(item.seller.username)}</strong>${item.isFriend ? ' <span class="friend-tag">ami</span>' : ""}</td>
    <td><strong>${money(price)}</strong></td>
    <td class="${diff === 0 ? "up" : "muted"}">${diff === 0 ? "Meilleur prix" : `+${diff.toFixed(0)} %`}</td>
    <td class="muted">${escapeHtml(fmtAgo(item.created_at))}</td>
    <td class="actions">${item.isMine
      ? '<span class="pill">Ton annonce</span>'
      : `<button type="button" class="button primary small" data-offer-buy="${Number(item.id)}">Acheter</button>`}</td>
  </tr>`;
}

function renderCardMarket(data) {
  const { card, listings, stats, sales, owned } = data;
  const rarity = RARITY[rarityOf(card)];
  const floor = stats.floor !== null && stats.floor !== undefined ? Number(stats.floor) : 0;
  const cheapest = listings.find((item) => !item.isMine);
  const stat = (label, value) => `<div><span>${label}</span><strong>${value}</strong></div>`;

  openModal(`
    <div class="market-card">
      <div class="market-side">
        ${cardTile(card, { quantity: owned })}
        <p class="muted">Tu possèdes ${owned} exemplaire${owned > 1 ? "s" : ""}.</p>
        ${owned > 0 ? '<button type="button" class="button secondary full" id="market-sell">Vendre un exemplaire</button>' : ""}
      </div>

      <div class="market-main">
        <h2>${escapeHtml(card.name)}</h2>
        <p>
          <span class="pill" style="border-color:${rarity.color};color:${rarity.color}">${rarity.label}</span>
          ${card.series ? `<span class="pill">${escapeHtml(card.series)}</span>` : ""}
        </p>

        <div class="range-stats">
          ${stat("Prix le plus bas", floor ? money(floor) : "—")}
          ${stat("Dernière vente", stats.lastSold !== null && stats.lastSold !== undefined ? money(stats.lastSold) : "—")}
          ${stat("Prix moyen", stats.average !== null && stats.average !== undefined ? money(stats.average) : "—")}
          ${stat("Offres", stats.activeCount)}
        </div>

        ${cheapest
          ? `<button type="button" class="button primary" id="market-cheapest" data-offer-buy="${Number(cheapest.id)}">Acheter le moins cher · ${money(cheapest.price)}</button>`
          : ""}

        <h3>Historique des ventes</h3>
        <div id="market-chart" class="chart-wrap"></div>

        <h3>Offres (${listings.length})</h3>
        ${listings.length
          ? `<div class="table-wrap"><table class="data-table">
              <thead><tr><th>Vendeur</th><th>Prix</th><th>Écart</th><th>Depuis</th><th></th></tr></thead>
              <tbody>${listings.map((item) => offerRow(item, floor)).join("")}</tbody>
            </table></div>`
          : '<p class="muted">Aucune offre pour cette carte en ce moment.</p>'}
      </div>
    </div>`, {
    wide: true,
    onClose: () => { $("#modal-body").onclick = null; }
  });

  const chart = $("#market-chart");
  if (sales.length >= 2) {
    renderLineChart(chart, sales, { range: "3d" });
  } else {
    chart.innerHTML = '<p class="muted chart-empty">Pas encore assez de ventes pour tracer un graphique.</p>';
  }

  $("#modal-body").onclick = async (event) => {
    const buy = event.target.closest("[data-offer-buy]");
    if (buy) {
      const item = listings.find((offer) => offer.id === Number(buy.dataset.offerBuy));
      if (item) await buyFromMarket(item, card.id, buy);
      return;
    }

    if (event.target.closest("#market-sell")) {
      closeModal();
      if (!state.cards.length) await loadCollection();
      openSellModal(card.id);
    }
  };
}

async function openCardMarket(cardId) {
  renderCardMarket(await api(`/api/bazaar/cards/${encodeURIComponent(cardId)}`));
}

async function buyFromMarket(item, cardId, button) {
  const message = `Acheter « ${item.card.name} » à ${item.seller.username} pour ${money(item.price)} ?`;
  if (!confirm(message)) return;

  setBusy(button, true);

  try {
    const result = await api(`/api/bazaar/${item.id}/buy`, { method: "POST" });

    state.user.balance = result.balance;
    updateStats();
    toast(
      `Carte achetée : ${result.card.name} pour ${money(result.price)}${result.card.isNew ? " — nouvelle carte !" : ""}`,
      "success"
    );
    toastTitles(result.newTitles);
  } catch (error) {
    toastError(error);
  }

  // Que l'achat ait réussi ou non, on remet la fiche et la liste à jour.
  loadBazaarListings().catch(() => {});
  refreshCardData();

  try {
    const data = await api(`/api/bazaar/cards/${encodeURIComponent(cardId)}`);
    if (data.listings.length || data.owned > 0) renderCardMarket(data);
    else closeModal();
  } catch (error) {
    closeModal();
  }
}

/* ------------------------------------------------------------------ */
/* Mes annonces                                                        */
/* ------------------------------------------------------------------ */

function myListingTile(item) {
  return `<article class="listing">
    <button type="button" class="listing-art" data-detail="${Number(item.id)}" aria-label="Voir la carte ${escapeHtml(item.card.name)}">${cardTile(item.card)}</button>
    <div class="listing-info">
      <strong class="listing-price">${money(item.price)}</strong>
      <span class="muted">En vente depuis ${escapeHtml(fmtAgo(item.created_at))}</span>
    </div>
    <div class="listing-actions">
      <button type="button" class="button secondary small" data-reprice="${Number(item.id)}">Modifier le prix</button>
      <button type="button" class="button secondary small" data-cancel="${Number(item.id)}">Retirer</button>
    </div>
  </article>`;
}

function historyLine(item) {
  const sold = item.role === "sold";
  const price = Number(item.price);
  const net = price - Number((price * bazaarMine.feeRate).toFixed(2));

  return `<li>
    <span class="pill ${sold ? "sold" : "bought"}">${sold ? "Vendue" : "Achetée"}</span>
    <span>${escapeHtml(item.card.emoji)} <strong>${escapeHtml(item.card.name)}</strong>
      ${sold ? `à ${escapeHtml(item.buyer || "?")}` : `à ${escapeHtml(item.seller.username)}`}</span>
    <strong>${sold ? `+${money(net)}` : `-${money(price)}`}</strong>
    <small class="muted">${escapeHtml(fmtAgo(item.sold_at))}</small>
  </li>`;
}

function renderMyListings() {
  const { active, history } = bazaarMine;

  $("#bazaar-mine").innerHTML = `
    <section class="panel">
      <h3>Mes annonces en cours (${active.length})</h3>
      ${active.length
        ? `<div class="listing-grid">${active.map(myListingTile).join("")}</div>`
        : '<p class="muted">Tu n\'as aucune carte en vente. Va dans « Vendre une carte » pour en proposer une.</p>'}
    </section>
    <section class="panel">
      <h3>Historique</h3>
      ${history.length
        ? `<ul class="history-list">${history.map(historyLine).join("")}</ul>`
        : '<p class="muted">Aucune vente ou achat pour le moment.</p>'}
    </section>`;
}

async function loadMyListings() {
  const data = await api("/api/bazaar/mine");
  bazaarMine = {
    feeRate: Number(data.feeRate) || 0.05,
    active: data.active || [],
    history: data.history || []
  };
  $("#bazaar-count").textContent = `${bazaarMine.active.length} en vente`;
  renderMyListings();
}

// Renvoie true si le prix a été modifié.
async function repriceListing(id) {
  const item = bazaarMine.active.find((listing) => listing.id === id);
  if (!item) return false;

  const answer = prompt("Nouveau prix en crédits (entre 1 et 1 000 000) :", String(Number(item.price)));
  if (answer === null) return false;

  try {
    await api(`/api/bazaar/${id}`, {
      method: "PATCH",
      body: jsonBody({ price: Number(String(answer).replace(",", ".")) })
    });
    toast("Prix modifié.", "success");
    await loadMyListings();
    return true;
  } catch (error) {
    toastError(error);
    return false;
  }
}

// Renvoie true si l'annonce a été retirée.
async function cancelMyListing(id, button) {
  if (!confirm("Retirer cette annonce ? La carte reviendra dans ta collection.")) return false;

  setBusy(button, true);

  try {
    await api(`/api/bazaar/${id}/cancel`, { method: "POST" });
    toast("Annonce retirée, la carte est revenue dans ta collection.", "success");
    await Promise.allSettled([loadMyListings(), refreshCardData()]);
    return true;
  } catch (error) {
    toastError(error);
    setBusy(button, false);
    return false;
  }
}

function openMyListingDetail(item) {
  const rarity = RARITY[rarityOf(item.card)];

  openModal(`
    <div class="card-detail listing-detail">
      <div class="card-detail-art">${cardTile(item.card)}</div>
      <div class="card-detail-info">
        <h2>${escapeHtml(item.card.name)}</h2>
        <p>
          <span class="pill" style="border-color:${rarity.color};color:${rarity.color}">${rarity.label}</span>
          ${item.card.series ? `<span class="pill">${escapeHtml(item.card.series)}</span>` : ""}
        </p>
        <p>${escapeHtml(item.card.description)}</p>
        <p class="detail-price">${money(item.price)}</p>
        <p class="muted">C'est ton annonce · en vente ${escapeHtml(fmtAgo(item.created_at))}</p>
        <div class="detail-actions">
          <button type="button" class="button secondary" id="detail-reprice">Modifier le prix</button>
          <button type="button" class="button secondary" id="detail-cancel">Retirer l'annonce</button>
        </div>
      </div>
    </div>`, { wide: true });

  $("#detail-reprice").addEventListener("click", async () => {
    if (await repriceListing(item.id)) closeModal();
  });
  $("#detail-cancel").addEventListener("click", async (event) => {
    if (await cancelMyListing(item.id, event.currentTarget)) closeModal();
  });
}

/* ------------------------------------------------------------------ */
/* Vendre                                                              */
/* ------------------------------------------------------------------ */

function renderSellGrid() {
  const owned = state.cards.filter((card) => Number(card.quantity) > 0);
  $("#bazaar-count").textContent = `${owned.length} carte${owned.length > 1 ? "s" : ""} à vendre`;

  $("#bazaar-sell").innerHTML = owned.length
    ? `<p class="muted">Choisis la carte à vendre : tu fixes toi-même le prix.</p>
       <div class="card-grid">${owned.map((card) => `
         <button type="button" class="collect-card" data-sell="${escapeHtml(card.id)}" aria-label="Vendre ${escapeHtml(card.name)}">
           ${cardTile(card, { quantity: Number(card.quantity) })}
         </button>`).join("")}</div>`
    : '<p class="muted">Tu ne possèdes encore aucune carte. Ouvre des packs dans la boutique !</p>';
}

async function openSellModal(cardId) {
  const card = state.cards.find((item) => String(item.id) === String(cardId));
  if (!card) {
    toast("Carte introuvable dans ta collection. Recharge la page puis réessaie.", "error");
    return;
  }

  const owned = Number(card.quantity);
  const key = rarityOf(card);
  let feeRate = 0.05;

  openModal(`
    <div class="card-detail">
      <div class="card-detail-art">${cardTile(card, { quantity: owned })}</div>
      <form id="sell-form" class="card-detail-info stack">
        <h2>Vendre « ${escapeHtml(card.name)} »</h2>
        <p id="sell-hint" class="muted">Chargement des prix du marché…</p>

        <label for="sell-price">Prix par carte (crédits)</label>
        <input id="sell-price" type="number" min="1" max="1000000" step="0.01" value="${SUGGESTED_PRICE[key]}" required>
        <div id="sell-chips" class="quick"></div>

        <label for="sell-qty">Quantité (tu en possèdes ${owned})</label>
        <input id="sell-qty" type="number" min="1" max="${Math.min(owned, 10)}" step="1" value="1" required>

        <p id="sell-net" class="muted"></p>
        <button type="submit" class="button primary full">Mettre en vente</button>
      </form>
    </div>`, { wide: true });

  const updateNet = () => {
    const price = Number($("#sell-price").value);
    const quantity = Number($("#sell-qty").value);
    const net = Number.isFinite(price) && Number.isFinite(quantity) && price > 0 && quantity > 0
      ? price * quantity * (1 - feeRate)
      : 0;

    $("#sell-net").innerHTML = net > 0
      ? `Tu recevras <strong>${money(net)}</strong> une fois vendue (commission de ${Math.round(feeRate * 100)} %).`
      : "";
  };

  $("#sell-price").addEventListener("input", updateNet);
  $("#sell-qty").addEventListener("input", updateNet);
  updateNet();

  api(`/api/bazaar/price/${encodeURIComponent(card.id)}`).then((info) => {
    if (!$("#sell-hint")) return;

    feeRate = Number(info.feeRate) || feeRate;
    const hasFloor = info.floor !== null && info.floor !== undefined;
    const hasLast = info.lastSold !== null && info.lastSold !== undefined;
    const hasAverage = info.average !== null && info.average !== undefined;

    const parts = [];
    if (hasFloor) parts.push(`Prix le plus bas : ${money(info.floor)} (${info.activeCount} offre${info.activeCount > 1 ? "s" : ""})`);
    if (hasLast) parts.push(`Dernière vente : ${money(info.lastSold)}`);

    $("#sell-hint").textContent = parts.length
      ? parts.join(" · ")
      : "Personne ne vend cette carte pour l'instant : à toi de fixer le prix.";

    // Boutons de prix rapides.
    const chips = [];
    if (hasFloor) {
      chips.push(["Un peu moins cher", Math.max(1, Number((Number(info.floor) - 1).toFixed(2)))]);
      chips.push(["Prix le plus bas", Number(info.floor)]);
    }
    if (hasLast) chips.push(["Dernière vente", Number(info.lastSold)]);
    if (hasAverage) chips.push(["Prix moyen", Number(info.average)]);

    $("#sell-chips").innerHTML = chips.map(([label, value]) =>
      `<button type="button" class="chip" data-price="${value}">${label} · ${fmtPrice(value)}</button>`
    ).join("");

    const start = hasFloor ? Number(info.floor) : hasLast ? Number(info.lastSold) : null;
    if (start !== null) $("#sell-price").value = String(start);
    updateNet();
  }).catch(() => {
    if ($("#sell-hint")) $("#sell-hint").textContent = "Fixe le prix que tu veux.";
  });

  $("#sell-chips").addEventListener("click", (event) => {
    const chip = event.target.closest("[data-price]");
    if (!chip) return;
    $("#sell-price").value = chip.dataset.price;
    updateNet();
  });

  $("#sell-form").addEventListener("submit", async (event) => {
    event.preventDefault();

    const submit = $("button[type=submit]", event.target);
    setBusy(submit, true);

    try {
      const result = await api("/api/bazaar/list", {
        method: "POST",
        body: jsonBody({
          cardId: card.id,
          price: Number($("#sell-price").value),
          quantity: Number($("#sell-qty").value)
        })
      });

      closeModal();
      toast(`${result.listed} annonce${result.listed > 1 ? "s" : ""} créée${result.listed > 1 ? "s" : ""} au bazar.`, "success");
      await refreshCardData();
      renderSellGrid();
    } catch (error) {
      toastError(error);
      setBusy(submit, false);
    }
  });
}

/* ------------------------------------------------------------------ */
/* Branchement                                                         */
/* ------------------------------------------------------------------ */

function setupBazaar() {
  $("#bazaar-nav").innerHTML = BAZAAR_VIEWS.map(([key, label]) =>
    `<button type="button" class="chip${key === state.bazaar.view ? " active" : ""}" data-view="${key}">${label}</button>`
  ).join("");

  $("#bazaar-nav").addEventListener("click", (event) => {
    const button = event.target.closest("[data-view]");
    if (!button) return;

    state.bazaar.view = button.dataset.view;
    loadBazaar().catch(toastError);
  });

  const reload = () => loadBazaarListings().catch(toastError);

  $("#bazaar-search").addEventListener("input", debounce((event) => {
    state.bazaar.filter.search = event.target.value;
    reload();
  }, 300));
  $("#bazaar-rarity").addEventListener("change", (event) => {
    state.bazaar.filter.rarity = event.target.value;
    reload();
  });
  $("#bazaar-seller").addEventListener("change", (event) => {
    state.bazaar.filter.seller = event.target.value;
    reload();
  });
  $("#bazaar-sort").addEventListener("change", (event) => {
    state.bazaar.filter.sort = event.target.value;
    reload();
  });

  $("#bazaar-list").addEventListener("click", (event) => {
    const market = event.target.closest("[data-market]");
    if (market) openCardMarket(market.dataset.market).catch(toastError);
  });

  $("#bazaar-mine").addEventListener("click", (event) => {
    const detail = event.target.closest("[data-detail]");
    const reprice = event.target.closest("[data-reprice]");
    const cancel = event.target.closest("[data-cancel]");

    if (detail) {
      const item = bazaarMine.active.find((listing) => listing.id === Number(detail.dataset.detail));
      if (item) openMyListingDetail(item);
    }
    if (reprice) repriceListing(Number(reprice.dataset.reprice));
    if (cancel) cancelMyListing(Number(cancel.dataset.cancel), cancel);
  });

  $("#bazaar-sell").addEventListener("click", (event) => {
    const button = event.target.closest("[data-sell]");
    if (button) openSellModal(button.dataset.sell).catch(toastError);
  });
}
