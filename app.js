"use strict";

const $ = (selector) => document.querySelector(selector);

let currentUser = null;
let authMode = "login";

const money = (value) =>
  Number(value || 0).toLocaleString("fr-FR", {
    style: "decimal",
    maximumFractionDigits: 2
  }) + " crédits";

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;",
    '"': "&quot;", "'": "&#39;"
  })[char]);
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
    // Session expirée pendant l'utilisation : retour à l'écran de connexion.
    if (response.status === 401 && currentUser) {
      currentUser = null;
      resetTabs();
      renderAccount();
      showMessage("Ta session a expiré. Reconnecte-toi.", true);
    }
    throw new Error(data.error || "Une erreur est survenue.");
  }

  return data;
}

function showMessage(message, isError = false, target = "#page-message") {
  const element = $(target);
  if (!element) return;
  element.textContent = message;
  element.classList.toggle("error", isError);
}

function showAuth(mode) {
  authMode = mode;
  $("#auth-panel").classList.remove("hidden");
  $("#auth-title").textContent = mode === "register" ? "Créer un compte" : "Connexion";
  $("#auth-submit").textContent = mode === "register" ? "Créer mon compte" : "Se connecter";
  $("#password").autocomplete = mode === "register" ? "new-password" : "current-password";
  $("#auth-message").textContent = "";
  $("#password").value = "";
  $("#username").focus();
}

function resetTabs() {
  document.querySelectorAll(".tab").forEach((tab) =>
    tab.classList.toggle("active", tab.dataset.page === "market")
  );
  document.querySelectorAll(".page-section").forEach((section) =>
    section.classList.toggle("hidden", section.id !== "page-market")
  );
}

function renderAccount() {
  const connected = Boolean(currentUser);
  $("#auth-panel").classList.add("hidden");
  $("#welcome-panel").classList.toggle("hidden", connected);
  $("#dashboard").classList.toggle("hidden", !connected);

  $("#account-area").innerHTML = connected
    ? `<span class="pill">${escapeHtml(currentUser.username)}</span>`
    : `<button type="button" class="button secondary" id="show-login">Connexion</button>
       <button type="button" class="button primary" id="show-register">Créer un compte</button>`;

  if (connected) {
    $("#user-name").textContent = currentUser.username;
    $("#balance").textContent = money(currentUser.balance);
    $("#admin-tab").classList.toggle("hidden", currentUser.role !== "admin");
  }
}

// Un seul écouteur pour les boutons Connexion / Créer un compte,
// même après que la zone du compte a été redessinée.
$("#account-area").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.id === "show-login") showAuth("login");
  if (button.id === "show-register") showAuth("register");
});

async function loadMarket() {
  const data = await api("/api/market");
  const assets = Array.isArray(data.assets) ? data.assets : [];

  $("#market-list").innerHTML = assets.length
    ? assets.map(asset => `
      <article class="asset-card">
        <div class="asset-symbol">${escapeHtml(asset.symbol)}</div>
        <h3>${escapeHtml(asset.name)}</h3>
        <div class="price">${money(asset.price)}</div>
        <p class="muted">Cours simulé</p>
        <p>Quantité</p>
        <input type="number" min="0.001" max="1000000" step="0.001"
          class="qty-input" value="1" aria-label="Quantité pour ${escapeHtml(asset.symbol)}">
        <div style="display:flex;gap:8px;margin-top:12px">
          <button type="button" class="button primary" data-trade="buy" data-symbol="${escapeHtml(asset.symbol)}">Acheter</button>
          <button type="button" class="button secondary" data-trade="sell" data-symbol="${escapeHtml(asset.symbol)}">Vendre</button>
        </div>
      </article>`).join("")
    : "<p>Aucun actif disponible.</p>";

  $("#market-list").querySelectorAll("[data-trade]").forEach(button => {
    button.addEventListener("click", async () => {
      const card = button.closest(".asset-card");
      const quantity = Number(card.querySelector(".qty-input").value);

      if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1000000) {
        return showMessage("Saisis une quantité valide.", true);
      }

      // Évite les doubles clics qui enverraient deux ordres.
      const buttons = card.querySelectorAll("button");
      buttons.forEach(item => { item.disabled = true; });

      try {
        const result = await api("/api/trade", {
          method: "POST",
          body: JSON.stringify({
            symbol: button.dataset.symbol,
            quantity,
            side: button.dataset.trade
          })
        });

        currentUser.balance = result.balance;
        renderAccount();
        showMessage("Opération simulée effectuée.");
        await Promise.all([loadMarket(), loadPortfolio()]);
      } catch (error) {
        showMessage(error.message, true);
        buttons.forEach(item => { item.disabled = false; });
      }
    });
  });
}

async function loadPortfolio() {
  const data = await api("/api/portfolio");
  const holdings = Array.isArray(data.holdings) ? data.holdings : [];
  $("#holding-count").textContent = holdings.length;
}

async function loadShop() {
  const data = await api("/api/shop");
  const packs = Array.isArray(data.packs) ? data.packs : [];

  $("#shop-list").innerHTML = packs.length
    ? packs.map(pack => `
      <article class="shop-card">
        <div class="card-art">✦</div>
        <h3>${escapeHtml(pack.name)}</h3>
        <p>${escapeHtml(pack.description)}</p>
        <div class="price">${money(pack.price)}</div>
        <p class="muted">Stock : ${Number(pack.stock) || 0}</p>
        <button type="button" class="button primary full" data-pack="${Number(pack.id)}"
          ${Number(pack.stock) <= 0 ? "disabled" : ""}>Acheter le pack</button>
      </article>`).join("")
    : "<p>La boutique est vide pour le moment.</p>";

  $("#shop-list").querySelectorAll("[data-pack]").forEach(button => {
    button.addEventListener("click", async () => {
      button.disabled = true;

      try {
        const result = await api("/api/shop/buy", {
          method: "POST",
          body: JSON.stringify({ packId: Number(button.dataset.pack) })
        });
        currentUser.balance = result.balance;
        renderAccount();
        showMessage("Pack ouvert ! Tes cartes ont été ajoutées à ta collection.");
        await Promise.all([loadShop(), loadCollection()]);
      } catch (error) {
        showMessage(error.message, true);
        button.disabled = false;
      }
    });
  });
}

async function loadCollection() {
  const data = await api("/api/cards");
  const cards = Array.isArray(data.cards) ? data.cards : [];
  const count = cards.reduce((sum, card) => sum + Number(card.quantity || 0), 0);
  $("#card-count").textContent = count;

  $("#collection-list").innerHTML = cards.length
    ? cards.map(card => `
      <article class="collect-card">
        <div class="card-art">✧</div>
        <span class="pill">${escapeHtml(card.rarity)}</span>
        <h3>${escapeHtml(card.name)}</h3>
        <p>Quantité : ${Number(card.quantity) || 0}</p>
      </article>`).join("")
    : "<p>Ta collection est vide. Essaie d'ouvrir un pack !</p>";
}

async function loadTitles() {
  const data = await api("/api/titles");
  const titles = Array.isArray(data.titles) ? data.titles : [];

  $("#titles-list").innerHTML = titles.length
    ? titles.map(title => `
      <article class="title-card">
        <div class="card-art">♜</div>
        <h3>${escapeHtml(title.name)}</h3>
        <p>${escapeHtml(title.description)}</p>
        <span class="pill">${title.unlocked ? "Débloqué" : "À débloquer"}</span>
      </article>`).join("")
    : "<p>Aucun titre disponible.</p>";
}

async function loadAdmin() {
  if (currentUser?.role !== "admin") return;

  const data = await api("/api/admin/users");
  const users = Array.isArray(data.users) ? data.users : [];

  $("#admin-users").innerHTML = users.map(user => `
    <article class="asset-card">
      <strong>${escapeHtml(user.username)}</strong>
      <p>${escapeHtml(user.role)} · ${money(user.balance)}</p>
    </article>`).join("") || "<p>Aucun utilisateur.</p>";
}

// Charge toutes les sections ; une section en échec n'empêche pas
// les autres de s'afficher. Retourne true si tout s'est bien passé.
async function refreshDashboard() {
  renderAccount();
  if (!currentUser) return false;

  const tasks = [
    loadMarket(),
    loadPortfolio(),
    loadShop(),
    loadCollection(),
    loadTitles()
  ];

  if (currentUser.role === "admin") tasks.push(loadAdmin());

  const results = await Promise.allSettled(tasks);
  const failure = results.find(result => result.status === "rejected");

  if (failure) {
    showMessage(failure.reason?.message || "Chargement incomplet.", true);
    return false;
  }

  return true;
}

$("#close-auth").addEventListener("click", () => $("#auth-panel").classList.add("hidden"));

$("#auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();

  const submit = $("#auth-submit");
  const username = $("#username").value.trim();
  const password = $("#password").value;

  submit.disabled = true;

  try {
    const result = await api(authMode === "register" ? "/api/register" : "/api/login", {
      method: "POST",
      body: JSON.stringify({ username, password })
    });

    currentUser = result.user;
    $("#password").value = "";
    $("#auth-message").textContent = "";
    resetTabs();
    showMessage("");

    const loaded = await refreshDashboard();
    if (loaded) showMessage("Bienvenue sur Sigma Exchange !");
  } catch (error) {
    showMessage(error.message, true, "#auth-message");
  } finally {
    submit.disabled = false;
  }
});

$("#logout").addEventListener("click", async () => {
  try {
    await api("/api/logout", { method: "POST" });
    currentUser = null;
    resetTabs();
    renderAccount();
    showMessage("Tu es déconnecté.");
  } catch (error) {
    showMessage(error.message, true);
  }
});

document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", async () => {
    if (tab.classList.contains("hidden")) return;

    document.querySelectorAll(".tab").forEach(item =>
      item.classList.toggle("active", item === tab)
    );

    document.querySelectorAll(".page-section").forEach(section =>
      section.classList.toggle("hidden", section.id !== `page-${tab.dataset.page}`)
    );

    if (tab.dataset.page === "admin") {
      try { await loadAdmin(); }
      catch (error) { showMessage(error.message, true); }
    }
  });
});

$("#restock").addEventListener("click", async () => {
  try {
    await api("/api/admin/shop/restock", { method: "POST" });
    await loadShop();
    showMessage("Le stock a été renouvelé.", false, "#admin-message");
  } catch (error) {
    showMessage(error.message, true, "#admin-message");
  }
});

async function init() {
  try {
    const data = await api("/api/me");
    currentUser = data.user;
    renderAccount();

    if (currentUser) {
      await refreshDashboard();
    }
  } catch (error) {
    console.error("Initialisation :", error);
    showMessage("Impossible de charger le site. Vérifie le serveur.", true);
  }
}

init();
