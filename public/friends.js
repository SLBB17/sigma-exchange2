"use strict";

function avatarColor(name) {
  return `hsl(${hashString(String(name)) % 360} 55% 42%)`;
}

function avatarHtml(name, size = 44) {
  const initial = escapeHtml(String(name || "?").charAt(0).toUpperCase());
  return `<span class="avatar" style="width:${size}px;height:${size}px;background:${avatarColor(name)}">${initial}</span>`;
}

function presenceHtml(person) {
  return person.online
    ? '<span class="presence on"></span>En ligne'
    : `<span class="presence"></span>Vu ${escapeHtml(fmtAgo(person.lastSeen))}`;
}

function updateFriendsBadge() {
  const badge = $("#friends-badge");
  if (!badge) return;

  const count = state.friends.incoming.length;
  badge.textContent = count;
  badge.classList.toggle("hidden", count === 0);
}

async function loadFriends() {
  const data = await api("/api/friends");

  state.friends = {
    friends: data.friends || [],
    incoming: data.incoming || [],
    outgoing: data.outgoing || []
  };

  updateFriendsBadge();
  if (currentTab === "friends") renderFriends();
}

function friendCard(friend) {
  return `<article class="friend-card">
    ${avatarHtml(friend.username)}
    <div class="friend-info">
      <strong>${escapeHtml(friend.username)}</strong>
      <span class="muted">${presenceHtml(friend)}</span>
    </div>
    <div class="friend-actions">
      <button type="button" class="button secondary small" data-profile="${Number(friend.id)}">Profil</button>
      <button type="button" class="button secondary small" data-gift="${Number(friend.id)}" data-name="${escapeHtml(friend.username)}">Offrir une carte</button>
      <button type="button" class="button secondary small" data-remove="${Number(friend.id)}" data-name="${escapeHtml(friend.username)}">Retirer</button>
    </div>
  </article>`;
}

function requestRow(person, incoming) {
  return `<li>
    ${avatarHtml(person.username, 34)}
    <span><strong>${escapeHtml(person.username)}</strong>
      <small class="muted">${escapeHtml(fmtAgo(person.sentAt))}</small></span>
    <span class="row-actions">
      ${incoming
        ? `<button type="button" class="button primary small" data-accept="${Number(person.requestId)}">Accepter</button>
           <button type="button" class="button secondary small" data-decline="${Number(person.requestId)}">Refuser</button>`
        : `<button type="button" class="button secondary small" data-decline="${Number(person.requestId)}">Annuler</button>`}
    </span>
  </li>`;
}

function renderFriends() {
  const { friends, incoming, outgoing } = state.friends;

  $("#friends-content").innerHTML = `
    ${incoming.length ? `<section class="panel">
      <h3>Demandes reçues (${incoming.length})</h3>
      <ul class="request-list">${incoming.map((person) => requestRow(person, true)).join("")}</ul>
    </section>` : ""}

    ${outgoing.length ? `<section class="panel">
      <h3>Demandes envoyées (${outgoing.length})</h3>
      <ul class="request-list">${outgoing.map((person) => requestRow(person, false)).join("")}</ul>
    </section>` : ""}

    <h3 class="friends-title">Mes amis (${friends.length})</h3>
    ${friends.length
      ? `<div class="friend-grid">${friends.map(friendCard).join("")}</div>`
      : '<p class="muted">Tu n\'as pas encore d\'ami. Envoie une demande avec le pseudo d\'un autre joueur !</p>'}`;
}

async function sendFriendRequest(username) {
  const result = await api("/api/friends/request", {
    method: "POST",
    body: jsonBody({ username })
  });

  toast(
    result.status === "accepted"
      ? `Vous êtes maintenant amis avec ${result.username} !`
      : `Demande envoyée à ${result.username}.`,
    "success"
  );

  await loadFriends();
  if (result.status === "accepted") loadTitles().catch(() => {});
}

async function openFriendProfile(friendId) {
  const data = await api(`/api/friends/${friendId}/profile`);
  const { user, titles, cards, totalCards } = data;
  const copies = cards.reduce((sum, card) => sum + Number(card.quantity), 0);

  openModal(`
    <div class="profile-head">
      ${avatarHtml(user.username, 64)}
      <div>
        <h2>${escapeHtml(user.username)}</h2>
        <p class="muted">${presenceHtml(user)} · membre depuis le ${escapeHtml(new Date(user.created_at).toLocaleDateString("fr-FR"))}</p>
      </div>
    </div>

    <div class="rarity-pills">
      <span class="pill">${cards.length} / ${totalCards} cartes découvertes</span>
      <span class="pill">${copies} exemplaire${copies > 1 ? "s" : ""}</span>
      <span class="pill">${titles.length} titre${titles.length > 1 ? "s" : ""}</span>
    </div>

    <h3>Titres</h3>
    <div class="rarity-pills">${titles.length
      ? titles.map((title) => `<span class="pill admin" title="${escapeHtml(title.description)}">${escapeHtml(title.name)}</span>`).join("")
      : '<span class="muted">Aucun titre pour le moment.</span>'}</div>

    <h3>Collection</h3>
    ${cards.length
      ? `<div class="card-grid compact">${cards.map((card) => cardTile(card, { quantity: Number(card.quantity) })).join("")}</div>`
      : '<p class="muted">Aucune carte pour le moment.</p>'}`, { wide: true });
}

async function openGiftModal(friendId, friendName) {
  if (!state.cards.length) await loadCollection();
  const owned = state.cards.filter((card) => Number(card.quantity) > 0);

  if (!owned.length) {
    openModal(`<h2>Offrir une carte</h2>
      <p class="muted">Tu ne possèdes aucune carte à offrir pour le moment.</p>`);
    return;
  }

  openModal(`
    <h2>Offrir une carte à ${escapeHtml(friendName)}</h2>
    <p class="muted">La carte est retirée de ta collection et ajoutée à la sienne. Le cadeau est définitif.</p>
    <form id="gift-form" class="stack">
      <label for="gift-card">Carte à offrir</label>
      <select id="gift-card">${owned.map((card) =>
        `<option value="${Number(card.id)}">${escapeHtml(card.emoji)} ${escapeHtml(card.name)} (${RARITY[rarityOf(card)].label}) ×${Number(card.quantity)}</option>`
      ).join("")}</select>
      <button type="submit" class="button primary full">Offrir cette carte</button>
    </form>`);

  $("#gift-form").addEventListener("submit", async (event) => {
    event.preventDefault();

    const submit = $("button[type=submit]", event.target);
    setBusy(submit, true);

    try {
      const result = await api(`/api/friends/${friendId}/gift`, {
        method: "POST",
        body: jsonBody({ cardId: Number($("#gift-card").value) })
      });

      closeModal();
      toast(`« ${result.card} » offerte à ${result.to}.`, "success");
      await refreshCardData();
    } catch (error) {
      toastError(error);
      setBusy(submit, false);
    }
  });
}

function setupFriends() {
  const input = $("#friend-input");

  // Suggestions de pseudos pendant la saisie.
  input.addEventListener("input", debounce(async () => {
    const query = input.value.trim();
    const list = $("#friend-suggestions");

    if (query.length < 2) {
      list.innerHTML = "";
      return;
    }

    try {
      const data = await api(`/api/users/search?q=${encodeURIComponent(query)}`);
      list.innerHTML = data.users.map((name) => `<option value="${escapeHtml(name)}"></option>`).join("");
    } catch (error) {
      list.innerHTML = "";
    }
  }, 250));

  $("#friend-form").addEventListener("submit", async (event) => {
    event.preventDefault();

    const submit = $("button[type=submit]", event.target);
    setBusy(submit, true);

    try {
      await sendFriendRequest(input.value.trim());
      input.value = "";
    } catch (error) {
      toastError(error);
    } finally {
      setBusy(submit, false);
    }
  });

  $("#friends-content").addEventListener("click", async (event) => {
    const accept = event.target.closest("[data-accept]");
    const decline = event.target.closest("[data-decline]");
    const profile = event.target.closest("[data-profile]");
    const gift = event.target.closest("[data-gift]");
    const remove = event.target.closest("[data-remove]");

    try {
      if (accept) {
        setBusy(accept, true);
        await api(`/api/friends/requests/${Number(accept.dataset.accept)}/accept`, { method: "POST" });
        toast("Demande acceptée.", "success");
        await loadFriends();
        loadTitles().catch(() => {});
      } else if (decline) {
        setBusy(decline, true);
        await api(`/api/friends/requests/${Number(decline.dataset.decline)}`, { method: "DELETE" });
        await loadFriends();
      } else if (profile) {
        await openFriendProfile(Number(profile.dataset.profile));
      } else if (gift) {
        await openGiftModal(Number(gift.dataset.gift), gift.dataset.name);
      } else if (remove) {
        if (!confirm(`Retirer ${remove.dataset.name} de tes amis ?`)) return;
        await api(`/api/friends/${Number(remove.dataset.remove)}`, { method: "DELETE" });
        toast("Ami retiré.", "success");
        await loadFriends();
      }
    } catch (error) {
      toastError(error);
      loadFriends().catch(() => {});
    }
  });
}
