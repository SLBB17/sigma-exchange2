"use strict";

let chatTimer = null;
let chatSignature = "";

function chatMessageHtml(message) {
  const mine = state.user && message.username === state.user.username;
  const isAdminUser = state.user && state.user.role === "admin";

  return `<div class="chat-msg${mine ? " mine" : ""}" data-id="${Number(message.id)}">
    <div class="chat-meta">
      <strong>${escapeHtml(message.username)}</strong>
      ${message.role === "admin" ? '<span class="pill admin">Admin</span>' : ""}
      <span class="muted">${escapeHtml(fmtTime(message.created_at))}</span>
      ${isAdminUser ? `<button type="button" class="chat-delete" data-delete="${Number(message.id)}" title="Supprimer ce message" aria-label="Supprimer ce message">✕</button>` : ""}
    </div>
    <p>${escapeHtml(message.body)}</p>
  </div>`;
}

function renderChat(messages) {
  const role = state.user ? state.user.role : "";
  const signature = `${messages.map((message) => message.id).join(",")}|${role}`;
  if (signature === chatSignature) return;
  chatSignature = signature;

  const list = $("#chat-list");
  const atBottom = !list.children.length ||
    list.scrollHeight - list.scrollTop - list.clientHeight < 80;

  list.innerHTML = messages.length
    ? messages.map(chatMessageHtml).join("")
    : '<p class="muted chat-empty">Aucun message pour le moment. Lance la conversation !</p>';

  if (atBottom) list.scrollTop = list.scrollHeight;
}

async function loadChat() {
  const data = await api("/api/chat");
  renderChat(Array.isArray(data.messages) ? data.messages : []);
}

async function startChat() {
  stopChat();
  chatSignature = "";
  await loadChat();

  chatTimer = setInterval(() => {
    if (document.hidden || !state.user) return;
    loadChat().catch(() => {});
  }, 4000);
}

function stopChat() {
  clearInterval(chatTimer);
  chatTimer = null;
}

function setupChat() {
  const input = $("#chat-input");

  input.addEventListener("input", () => {
    $("#chat-count").textContent = `${input.value.length} / 300`;
  });

  $("#chat-form").addEventListener("submit", async (event) => {
    event.preventDefault();

    const message = input.value.trim();
    if (!message) return;

    const submit = $("button[type=submit]", event.target);
    setBusy(submit, true);

    try {
      const result = await api("/api/chat", {
        method: "POST",
        body: jsonBody({ message })
      });

      input.value = "";
      $("#chat-count").textContent = "0 / 300";

      toastTitles(result.newTitles);
      if (result.newTitles && result.newTitles.length) loadTitles().catch(() => {});

      await loadChat();
      const list = $("#chat-list");
      list.scrollTop = list.scrollHeight;
    } catch (error) {
      toastError(error);
    } finally {
      setBusy(submit, false);
      input.focus();
    }
  });

  $("#chat-list").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-delete]");
    if (!button) return;

    try {
      await api(`/api/admin/chat/${Number(button.dataset.delete)}`, { method: "DELETE" });
      await loadChat();
    } catch (error) {
      toastError(error);
    }
  });
}
