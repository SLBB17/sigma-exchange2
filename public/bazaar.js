"use strict";

// Prix conseillés par rareté quand personne ne vend encore la carte.
const SUGGESTED_PRICE = { common: 20, rare: 60, epic: 200, legendary: 800, mythic: 3000 };
const BAZAAR_VIEWS = [["buy", "Acheter"], ["mine", "Mes annonces"], ["sell", "Vendre une carte"]];

let bazaarListings = [];
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

/* ----- Acheter ----- */

function listingTile(item) {
  return `<article class="listing">
    <button type="button" class="listing-art" data-detail="${Number(item.id)}" aria-label="Voir la carte ${escapeHtml(item.card.name)}">${cardTile(item.card)}</button>
    <div class="listing-info">
      <strong class="listing-price">${money(item.price)}</strong>
      <span class="muted">${item.isMine ? "Ton annonce" : `par ${escapeHtml(item.seller.username)}`}${item.isFriend ? ' · <span class="friend-tag">ami</span>' : ""}</span>
    </div>
    ${item.isMine
      ? '<span class="pill">Ton annonce</span>'
      : `<button type="button" class="button primary small full" data-buy="${Number(item.id)}">Acheter</button>`}
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

  const data = await api(`/api/bazaar?${params}`);
  bazaarListings = Array.isArray(data.listings) ? data.listings : [];

  $("#bazaar-count").textContent = `${data.total} annonce${data.total > 1 ? "s" : ""}`;
  $("#bazaar-list").innerHTML = bazaarListings.length
    ? bazaarListings.map(listingTile).join("")
    : '<p class="muted">Aucune annonce ne correspond. Sois le premier à vendre une carte !</p>';
}

async function refreshCardData() {
  await Promise.allSettled([loadCollection(), loadTitles()]);
  updateStats();
}

// Renvoie true si l'achat a réussi.
async function buyListing(id, button) {
  const item = bazaarListings.find((listing) => listing.id === id);
  if (!item) return false;

  const message = `Acheter « ${item.card.name} » à ${item.seller.username} pour ${money(item.price)} ?`;
  if (!confirm(message)) return false;

  setBusy(button, true);

  try {
    const result = await api(`/api/bazaar/${id}/buy`, { method: "POST" });

    state.user.balance = result.balance;
    updateStats();
    toast(
      `Carte achetée : ${result.card.name} pour ${money(result.price)}${result.card.isNew ? " — nouvelle carte !" : ""}`,
      "success"
    );
    toastTitles(result.newTitles);

    await Promise.allSettled([loadBazaarListings(), refreshCardData()]);
    return true;
  } catch (error) {
    toastError(error);
    setBusy(button, false);
    loadBazaarListings().catch(() => {});
    return false;
  }
}

/* ----- Mes annonces ----- */

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

/* ----- Vendre ----- */

function renderSellGrid() {
  const owned = state.cards.filter((card) => Number(card.quantity) > 0);
  $("#bazaar-count").textContent = `${owned.length} carte${owned.length > 1 ? "s" : ""} à vendre`;

  $("#bazaar-sell").innerHTML = owned.length
    ? `<p class="muted">Choisis la carte à vendre : tu fixes toi-même le prix.</p>
       <div class="card-grid">${owned.map((card) => `
         <button type="button" class="collect-card" data-sell="${Number(card.id)}" aria-label="Vendre ${escapeHtml(card.name)}">
           ${cardTile(card, { quantity: Number(card.quantity) })}
         </button>`).join("")}</div>`
    : '<p class="muted">Tu ne possèdes encore aucune carte. Ouvre des packs dans la boutique !</p>';
}

async function openSellModal(cardId) {
  const card = state.cards.find((item) => item.id === cardId);
  if (!card) return;

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

  api(`/api/bazaar/price/${cardId}`).then((info) => {
    if (!$("#sell-hint")) return;

    feeRate = Number(info.feeRate) || feeRate;
    const parts = [];
    if (info.floor !== null && info.floor !== undefined) {
      parts.push(`Prix le plus bas en ce moment : ${money(info.floor)} (${info.activeCount} annonce${info.activeCount > 1 ? "s" : ""})`);
      $("#sell-price").value = String(Number(info.floor));
    } else if (info.lastSold !== null && info.lastSold !== undefined) {
      $("#sell-price").value = String(Number(info.lastSold));
    }
    if (info.lastSold !== null && info.lastSold !== undefined) {
      parts.push(`Dernière vente : ${money(info.lastSold)}`);
    }

    $("#sell-hint").textContent = parts.length
      ? parts.join(" · ")
      : "Personne ne vend cette carte pour l'instant : à toi de fixer le prix.";
    updateNet();
  }).catch(() => {
    if ($("#sell-hint")) $("#sell-hint").textContent = "Fixe le prix que tu veux.";
  });

  $("#sell-form").addEventListener("submit", async (event) => {
    event.preventDefault();

    const submit = $("button[type=submit]", event.target);
    setBusy(submit, true);

    try {
      const result = await api("/api/bazaar/list", {
        method: "POST",
        body: jsonBody({
          cardId,
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

/* ----- Fiche détaillée d'une annonce ----- */

function openListingDetail(item, mine) {
  const key = rarityOf(item.card);
  const rarity = RARITY[key];

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
        <p class="muted">${mine
          ? "C'est ton annonce"
          : `Vendue par <strong>${escapeHtml(item.seller.username)}</strong>${item.isFriend ? ' · <span class="friend-tag">ami</span>' : ""}`}
          · en vente ${escapeHtml(fmtAgo(item.created_at))}</p>
        <div class="detail-actions">
          ${mine
            ? `<button type="button" class="button secondary" id="detail-reprice">Modifier le prix</button>
               <button type="button" class="button secondary" id="detail-cancel">Retirer l'annonce</button>`
            : `<button type="button" class="button primary" id="detail-buy">Acheter pour ${money(item.price)}</button>`}
        </div>
      </div>
    </div>`, { wide: true });

  if (mine) {
    $("#detail-reprice").addEventListener("click", async () => {
      if (await repriceListing(item.id)) closeModal();
    });
    $("#detail-cancel").addEventListener("click", async (event) => {
      if (await cancelMyListing(item.id, event.currentTarget)) closeModal();
    });
  } else {
    $("#detail-buy").addEventListener("click", async (event) => {
      if (await buyListing(item.id, event.currentTarget)) closeModal();
    });
  }
}

/* ----- Branchement ----- */

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
    const detail = event.target.closest("[data-detail]");
    const button = event.target.closest("[data-buy]");

    if (detail) {
      const item = bazaarListings.find((listing) => listing.id === Number(detail.dataset.detail));
      if (item) openListingDetail(item, item.isMine);
    } else if (button) {
      buyListing(Number(button.dataset.buy), button);
    }
  });

  $("#bazaar-mine").addEventListener("click", (event) => {
    const detail = event.target.closest("[data-detail]");
    const reprice = event.target.closest("[data-reprice]");
    const cancel = event.target.closest("[data-cancel]");

    if (detail) {
      const item = bazaarMine.active.find((listing) => listing.id === Number(detail.dataset.detail));
      if (item) openListingDetail(item, true);
    }

    if (reprice) repriceListing(Number(reprice.dataset.reprice));
    if (cancel) cancelMyListing(Number(cancel.dataset.cancel), cancel);
  });

  $("#bazaar-sell").addEventListener("click", (event) => {
    const button = event.target.closest("[data-sell]");
    if (button) openSellModal(Number(button.dataset.sell));
  });
}
