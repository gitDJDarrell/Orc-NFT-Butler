// Plain vanilla JS single-page dashboard. No build step, no framework —
// talks to the Express API in src/dashboard/server.ts.

const $ = (sel) => document.querySelector(sel);

function fmtPrice(n, currency) {
  if (n === null || n === undefined) return "—";
  return `${n.toFixed(4)} ${currency ?? ""}`.trim();
}

function fmtChange(pct, approx) {
  if (pct === null || pct === undefined) return "—";
  const cls = pct > 0 ? "change-up" : pct < 0 ? "change-down" : "";
  const sign = pct > 0 ? "+" : "";
  const suffix = approx ? " *" : "";
  return `<span class="${cls}">${sign}${pct.toFixed(2)}%${suffix}</span>`;
}

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleTimeString();
}

// ---------- Status panel ----------

async function loadStatus() {
  const res = await fetch("/api/status");
  const s = await res.json();
  const badges = $("#status-badges");
  badges.innerHTML = "";

  const add = (label, on, extraClass) => {
    const el = document.createElement("span");
    el.className = `badge ${extraClass ?? (on ? "on" : "off")}`;
    el.textContent = label;
    badges.appendChild(el);
  };

  add(s.dryRun ? "DRY_RUN: on" : "DRY_RUN: OFF", s.dryRun, s.dryRun ? "on" : "warn");
  add(s.hasOpenSeaKey ? "OpenSea: live key" : "OpenSea: mock data", s.hasOpenSeaKey);
  add(s.discordEnabled ? "Discord webhook: configured" : "Discord webhook: disabled", s.discordEnabled);
  add(s.discordBotEnabled ? "Discord bot: online" : "Discord bot: disabled", s.discordBotEnabled);
  add(s.emailEnabled ? "Email: configured" : "Email: disabled", s.emailEnabled);
  add(`${s.chain} (chain ${s.chainId})`, true, "off");

  if (s.discordEnabled) {
    const btn = document.createElement("button");
    btn.textContent = "Send Discord test";
    btn.style.fontSize = "0.75rem";
    btn.style.padding = "0.2rem 0.6rem";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Sending…";
      try {
        const r = await fetch("/api/discord/test", { method: "POST" });
        const body = await r.json();
        btn.textContent = body.ok ? "Sent ✓" : "Failed";
      } catch {
        btn.textContent = "Failed";
      } finally {
        setTimeout(() => {
          btn.disabled = false;
          btn.textContent = "Send Discord test";
        }, 2500);
      }
    });
    badges.appendChild(btn);
  }
}

// ---------- Watchlist ----------

async function loadWatchlist() {
  const res = await fetch("/api/watchlist");
  const rows = await res.json();
  renderWatchlist(rows);
}

function renderWatchlist(rows) {
  const body = $("#watchlist-body");
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="5" class="muted">No collections watched — add one above.</td></tr>`;
    return;
  }

  body.innerHTML = rows
    .map(
      (r) => `
    <tr>
      <td title="${r.id}">${escapeHtml(r.name)}</td>
      <td>${fmtPrice(r.floorPriceNative, r.floorPriceCurrency)}</td>
      <td>${fmtChange(r.change24hPct, r.changeApprox)}</td>
      <td class="muted small">${fmtTime(r.lastUpdated)}</td>
      <td><button class="remove-btn" data-id="${r.id}">Remove</button></td>
    </tr>`,
    )
    .join("");

  body.querySelectorAll(".remove-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await fetch(`/api/watchlist/${encodeURIComponent(btn.dataset.id)}`, { method: "DELETE" });
      loadWatchlist();
    });
  });
}

$("#add-collection-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#add-collection-input");
  const errorEl = $("#watchlist-error");
  errorEl.textContent = "";

  const collectionId = input.value.trim();
  if (!collectionId) return;

  const res = await fetch("/api/watchlist", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ collectionId }),
  });
  const body = await res.json();

  if (!res.ok) {
    errorEl.textContent = body.error ?? "Failed to add collection";
    return;
  }

  input.value = "";
  renderWatchlist(body.watchlist);
});

// ---------- Alerts feed (SSE with polling fallback) ----------

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function alertItemHtml(a) {
  return `
    <li class="alert-item ${a.severity}">
      <span class="alert-time">${fmtTime(a.timestamp)}</span>
      <div class="alert-title">${escapeHtml(a.title)}</div>
      <div>${escapeHtml(a.message)}</div>
    </li>`;
}

function prependAlert(a) {
  const list = $("#alerts-list");
  if (list.firstElementChild?.classList.contains("muted")) list.innerHTML = "";
  list.insertAdjacentHTML("afterbegin", alertItemHtml(a));
  while (list.children.length > 200) list.removeChild(list.lastElementChild);
}

async function loadAlertHistory() {
  const res = await fetch("/api/alerts");
  const alerts = await res.json();
  const list = $("#alerts-list");
  list.innerHTML = alerts.length
    ? alerts.map(alertItemHtml).join("")
    : `<li class="muted">No alerts yet.</li>`;
}

function connectAlertsStream() {
  const status = $("#alerts-connection");
  if (typeof EventSource === "undefined") {
    status.textContent = "Live updates unsupported — polling every 15s";
    setInterval(loadAlertHistory, 15000);
    return;
  }

  const es = new EventSource("/api/alerts/stream");
  es.onopen = () => (status.textContent = "Live");
  es.onerror = () => {
    status.textContent = "Reconnecting…";
  };
  es.onmessage = (evt) => {
    try {
      prependAlert(JSON.parse(evt.data));
    } catch {
      // ignore malformed frames (e.g. the initial ": connected" comment)
    }
  };
}

// ---------- Order form ----------

const actionSelect = $("#order-action");
function updateOrderFormFields() {
  const action = actionSelect.value;
  $("#order-tokenid-label").classList.toggle("hidden", action === "bid");
  $("#order-price-label").classList.toggle("hidden", action === "acceptOffer");
  $("#order-offerid-label").classList.toggle("hidden", action !== "acceptOffer");
}
actionSelect.addEventListener("change", updateOrderFormFields);
updateOrderFormFields();

$("#order-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const resultEl = $("#order-result");
  resultEl.innerHTML = "Submitting…";

  const payload = {
    action: actionSelect.value,
    collectionId: $("#order-collection").value.trim(),
    tokenId: $("#order-tokenid").value.trim() || undefined,
    priceNative: $("#order-price").value ? Number($("#order-price").value) : undefined,
    offerId: $("#order-offerid").value.trim() || undefined,
    requestedBy: "dashboard",
  };

  const res = await fetch("/api/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json();

  if (body.ok) {
    resultEl.innerHTML = `
      <div class="result-ok">Dry-run order built — nothing was signed or sent.</div>
      <pre>${escapeHtml(JSON.stringify(body.dryRun, null, 2))}</pre>`;
  } else {
    resultEl.innerHTML = `
      <div class="result-error">Rejected</div>
      <pre>${escapeHtml((body.errors ?? []).join("\n"))}</pre>`;
  }
});

// ---------- Init ----------

loadStatus();
loadWatchlist();
loadAlertHistory().then(connectAlertsStream);
setInterval(loadWatchlist, 15000);
