const state = {
  csrf: "",
  dashboard: null,
  reviews: [],
  plans: [],
  activity: [],
  reviewLimit: 20,
};
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

await initialize();

async function initialize() {
  try {
    state.csrf = (await api("/api/session")).csrfToken;
    bindEvents();
    await refreshAll();
    setInterval(refreshLiveState, 3000);
  } catch (error) {
    $("#connection-label").textContent = "Local service unavailable";
    toast(error.message, true);
  }
}

function bindEvents() {
  $$(".tab").forEach((button) => {
    button.addEventListener("click", () => showView(button.dataset.view));
  });
  $$(".scan-trigger, #scan-button").forEach((button) => {
    button.addEventListener("click", startScan);
  });
  $("#create-plan-button").addEventListener("click", createPlan);
  $("#review-filter").addEventListener("change", resetReviewLimit);
  $("#review-search").addEventListener("input", resetReviewLimit);
  $("#schedule-form").addEventListener("submit", saveSchedule);
  $("#notification-form").addEventListener("submit", saveNotification);
  $("#backup-button").addEventListener("click", createBackup);
  $("#metadata-form").addEventListener("submit", saveMetadata);
  $$("[data-close-metadata]").forEach((button) => {
    button.addEventListener("click", () => $("#metadata-dialog").close());
  });
}

async function refreshAll() {
  const [dashboard, reviews, plans, activity, health, notification] =
    await Promise.all([
      api("/api/dashboard"),
      api("/api/reviews"),
      api("/api/plans"),
      api("/api/activity"),
      api("/api/health"),
      api("/api/notifications"),
    ]);
  Object.assign(state, {
    dashboard,
    reviews: reviews.records,
    plans: plans.records,
    activity: activity.records,
  });
  renderDashboard();
  renderReviews();
  renderPlans();
  renderActivity();
  renderOperations(health, notification);
}

async function refreshLiveState() {
  try {
    const dashboard = await api("/api/dashboard");
    const wasRunning = Boolean(state.dashboard?.activeOperation);
    state.dashboard = dashboard;
    renderDashboard();
    if (wasRunning && !dashboard.activeOperation) await refreshAll();
  } catch {
    $("#connection-label").textContent = "Connection interrupted";
  }
}

function renderDashboard() {
  const data = state.dashboard;
  if (!data) return;
  $("#connection-label").textContent = data.activeOperation
    ? `${titleCase(data.activeOperation.kind)} in progress`
    : "Local service ready";
  $("#scan-button").disabled = Boolean(data.activeOperation);
  $("#scan-button").textContent = data.activeOperation
    ? "Scanning..."
    : "Scan now";
  $("#review-tab-count").textContent = data.pendingReviews;
  $("#add-tab-count").textContent = data.proposedAdditions;
  $("#empty-state").classList.toggle("hidden", data.initialized);
  $("#metrics").classList.toggle("hidden", !data.initialized);
  $("#metrics").innerHTML = [
    metric("Wishlist", data.state.wishlist_items, "Current Bandcamp items"),
    metric("Matched", data.state.matched, "Catalogue matches"),
    metric(
      "Review",
      data.pendingReviews,
      "Need a decision",
      data.pendingReviews ? "warn" : "",
    ),
    metric("Ready", data.proposedAdditions, "Approved to add"),
    metric("Saved", data.state.already_saved, "Already in TIDAL"),
    metric(
      "Failed",
      data.recentFailures,
      "Need attention",
      data.recentFailures ? "danger" : "",
    ),
  ].join("");
  const run = data.lastRun;
  $("#last-run-label").textContent = run
    ? `Last refresh ${formatDate(run.finished_at ?? run.started_at)}`
    : "No refresh recorded";
  $("#run-status").textContent = run ? titleCase(run.status) : "Not started";
  $("#run-state-badge").textContent = data.activeOperation
    ? "Running"
    : (run?.status ?? "Idle");
  $("#run-state-badge").className =
    `badge ${data.activeOperation ? "running" : run?.status === "failed" ? "danger" : "safe"}`;
  $("#run-details").innerHTML = data.activeOperation
    ? detail("Operation", titleCase(data.activeOperation.kind)) +
      detail("Started", formatDate(data.activeOperation.startedAt)) +
      detail("Progress", data.activeOperation.message)
    : run
      ? detail("Mode", run.mode) +
        detail("Started", formatDate(run.started_at)) +
        detail("Finished", formatDate(run.finished_at))
      : detail("Status", "Run a read-only scan to establish local state");
  renderNextAction(data);
}

function renderNextAction(data) {
  let title = "State is ready";
  let copy = "Refresh when your Bandcamp wishlist or TIDAL collection changes.";
  let buttons = `<button class="primary scan-trigger-inline">Refresh now</button>`;
  if (data.pendingReviews > 0) {
    title = `Review ${data.pendingReviews} uncertain matches`;
    copy =
      "Approve correct matches, then find every decision under Add to TIDAL.";
    buttons = `<button class="primary" data-go="review">Open review queue</button><button data-go="plans">View approved matches</button>`;
  } else if (data.proposedAdditions > 0) {
    title = `${data.proposedAdditions} approved additions are ready`;
    copy =
      "Review the exact albums before choosing whether to add them to TIDAL.";
    buttons = `<button class="primary" data-go="plans">Review additions</button><button class="scan-trigger-inline">Refresh first</button>`;
  }
  $("#next-action-title").textContent = title;
  $("#next-action-copy").textContent = copy;
  $("#next-action-buttons").innerHTML = buttons;
  $$("[data-go]").forEach((button) => {
    button.addEventListener("click", () => showView(button.dataset.go));
  });
  $$(".scan-trigger-inline").forEach((button) => {
    button.addEventListener("click", startScan);
  });
  $("[data-create-plan]")?.addEventListener("click", createPlan);
}

function renderReviews() {
  const status = $("#review-filter").value;
  const query = $("#review-search").value.trim().toLowerCase();
  $("#review-title").textContent =
    {
      pending: "Review uncertain matches",
      ready_to_add: "Approved matches ready to add",
      already_saved: "Approved matches already in TIDAL",
      deferred: "Deferred decisions",
      unavailable: "Unavailable releases",
      rejected: "Rejected matches",
      all: "All saved decisions",
    }[status] ?? "Review matches";
  const records = state.reviews.filter((record) => {
    const effective = reviewState(record);
    const reviewable = Boolean(record.decision) || effective === "pending";
    return (
      reviewable &&
      (status === "all" || status === effective) &&
      (!query ||
        `${record.artist} ${record.title}`.toLowerCase().includes(query))
    );
  });
  const visible = records.slice(0, state.reviewLimit);
  $("#review-list").innerHTML = records.length
    ? `<p class="result-count">Showing ${visible.length} of ${records.length} ${status === "pending" ? "matches needing a decision" : "saved decisions"}</p>${visible.map(reviewRow).join("")}${visible.length < records.length ? '<div class="load-more"><button id="load-more-reviews" type="button">Show 20 more</button></div>' : ""}`
    : empty(
        status === "pending"
          ? "No matches need a decision"
          : "No saved decisions in this view",
        "Choose another status or refresh your accounts.",
      );
  $$("[data-review-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const candidate = ["approved", "rejected"].includes(
        button.dataset.reviewAction,
      )
        ? $(`[data-candidate-select="${button.dataset.id}"]`)?.value
        : button.dataset.candidate;
      return decide(button.dataset.id, button.dataset.reviewAction, candidate);
    });
  });
  $$("[data-review-edit]").forEach((button) => {
    button.addEventListener("click", () =>
      openMetadataEditor(button.dataset.id),
    );
  });
  $$(`[data-candidate-select]`).forEach((select) => {
    select.addEventListener("change", () => {
      const link = select
        .closest(".candidate")
        ?.querySelector("[data-candidate-link]");
      const artwork = select
        .closest(".candidate")
        ?.querySelector("[data-candidate-artwork]");
      if (!link || !artwork) return;
      const record = state.reviews.find(
        (item) =>
          String(item.bandcampItemId) ===
          String(select.dataset.candidateSelect),
      );
      const candidates = record?.candidates?.length
        ? record.candidates
        : record?.bestMatch?.tidal_album_id
          ? [record.bestMatch]
          : [];
      const candidate = candidates.find(
        (item) => String(item.tidal_album_id) === String(select.value),
      );
      if (!candidate || !select.value) {
        link.hidden = true;
        artwork.hidden = true;
        return;
      }
      link.href = safeTidalUrl(candidate.tidal_url, select.value);
      link.hidden = false;
      artwork.alt = `TIDAL artwork for ${candidate.tidal_title || "selected candidate"}`;
      artwork.hidden = false;
      artwork.src = tidalArtworkUrl(select.value);
    });
  });
  $$(`[data-candidate-artwork]`).forEach((image) => {
    image.addEventListener("error", () => {
      image.hidden = true;
    });
  });
  $("#load-more-reviews")?.addEventListener("click", () => {
    state.reviewLimit += 20;
    renderReviews();
  });
}

function resetReviewLimit() {
  state.reviewLimit = 20;
  renderReviews();
}

function reviewRow(record) {
  const best = record.bestMatch ?? {};
  const candidates = record.candidates?.length
    ? record.candidates
    : best.tidal_album_id
      ? [best]
      : [];
  const candidateOptions = candidates
    .map(
      (item) =>
        `<option value="${escapeAttr(item.tidal_album_id)}"${String(item.tidal_album_id) === String(record.decision?.chosenTidalAlbumId ?? best.tidal_album_id) ? " selected" : ""}>${escapeHtml(`${(item.tidal_artists ?? []).join(", ") || "Unknown artist"} - ${item.tidal_title || "Untitled"} (${item.score ?? "-"})`)}</option>`,
    )
    .join("");
  const effective = reviewState(record);
  const selectedId = record.decision?.chosenTidalAlbumId ?? best.tidal_album_id;
  const selectedCandidate = candidates.find(
    (item) => String(item.tidal_album_id) === String(selectedId),
  );
  const tidalUrl = selectedId
    ? safeTidalUrl(selectedCandidate?.tidal_url, selectedId)
    : null;
  const tidalArtwork = selectedId ? tidalArtworkUrl(selectedId) : null;
  const decisionNote = record.decision
    ? `<p class="decision-note"><strong>${escapeHtml(reviewStateLabel(effective))}</strong> · saved ${formatDate(record.decision.updatedAt)}</p>`
    : "";
  return `<article class="review-row">
    <img src="${record.artUrl ? escapeAttr(record.artUrl) : artworkFallback(record)}" alt="" />
    <div class="review-source"><span class="badge ${effective === "ready_to_add" ? "safe" : effective === "pending" ? "warn" : ""}">${escapeHtml(reviewStateLabel(effective))}</span><h2>${escapeHtml(record.artist)} - ${escapeHtml(record.title)}</h2>${decisionNote}<div class="provider-links"><a href="${escapeAttr(record.url)}" target="_blank" rel="noopener noreferrer">Open on Bandcamp</a></div></div>
    <div class="candidate"><span class="score">${record.score ?? "-"}</span><div class="candidate-body">${tidalArtwork ? `<img class="candidate-artwork" data-candidate-artwork src="${escapeAttr(tidalArtwork)}" alt="TIDAL artwork for ${escapeAttr(String(selectedCandidate?.tidal_title ?? "selected candidate"))}" />` : ""}<div class="candidate-copy"><label>TIDAL candidate<select data-candidate-select="${record.bandcampItemId}" ${candidates.length ? "" : "disabled"}>${candidateOptions || '<option value="">No candidate found</option>'}</select></label>${tidalUrl ? `<a class="candidate-link" data-candidate-link href="${escapeAttr(tidalUrl)}" target="_blank" rel="noopener noreferrer">Open in TIDAL</a>` : ""}<p>${escapeHtml(record.explanation || "No explanation recorded")}</p></div></div></div>
    <div class="review-actions"><button class="primary" data-review-action="approved" data-id="${record.bandcampItemId}" ${candidates.length ? "" : "disabled"}>Approve</button><button data-review-action="deferred" data-id="${record.bandcampItemId}" title="Leave this decision for later">Defer</button><button data-review-action="unavailable" data-id="${record.bandcampItemId}" title="Mark the release as currently unavailable">Unavailable</button><button data-review-edit data-id="${record.bandcampItemId}">Edit metadata</button><button class="danger-text" data-review-action="rejected" data-id="${record.bandcampItemId}" data-candidate="${escapeAttr(best.tidal_album_id ?? "")}" title="Reject this candidate as incorrect">Reject</button></div>
  </article>`;
}

function openMetadataEditor(id) {
  const record = state.reviews.find(
    (item) => String(item.bandcampItemId) === String(id),
  );
  if (!record) return;
  $("#metadata-item-id").value = record.bandcampItemId;
  $("#metadata-artist").value = record.metadata?.artist ?? record.artist ?? "";
  $("#metadata-title").value = record.metadata?.title ?? record.title ?? "";
  $("#metadata-label").value = record.metadata?.label ?? record.label ?? "";
  $("#metadata-dialog").showModal();
  $("#metadata-artist").focus();
}

async function saveMetadata(event) {
  event.preventDefault();
  const id = $("#metadata-item-id").value;
  try {
    await api(`/api/reviews/${id}`, {
      method: "POST",
      body: JSON.stringify({
        action: "edit",
        metadata: {
          artist: $("#metadata-artist").value,
          title: $("#metadata-title").value,
          label: $("#metadata-label").value,
        },
      }),
    });
    $("#metadata-dialog").close();
    toast("Matching metadata saved locally. Provider writes: 0.");
    await refreshAll();
  } catch (error) {
    toast(error.message, true);
  }
}

async function decide(id, action, candidateId) {
  await api(`/api/reviews/${id}`, {
    method: "POST",
    body: JSON.stringify({ action, candidateId: candidateId || undefined }),
  });
  await refreshAll();
  const record = state.reviews.find(
    (item) => String(item.bandcampItemId) === String(id),
  );
  const outcome = record
    ? reviewStateLabel(reviewState(record))
    : titleCase(action);
  toast(`${outcome}. Decision saved locally; TIDAL was not changed.`);
}

function renderPlans() {
  const approved = state.reviews.filter(
    (record) => record.decision?.action === "approved",
  );
  const ready = approved.filter((record) => !record.alreadyInTidal);
  const saved = approved.filter((record) => record.alreadyInTidal);
  $("#ready-additions-count").textContent = ready.length;
  $("#already-saved-count").textContent = saved.length;
  $("#create-plan-button").disabled = ready.length === 0;
  $("#ready-additions").innerHTML = ready.length
    ? ready.map(additionRow).join("")
    : empty(
        "Nothing waiting to be added",
        "Approve a correct match that is not already in TIDAL.",
      );
  $("#already-saved-additions").innerHTML = saved.length
    ? saved.map(additionRow).join("")
    : empty(
        "No approved matches are already saved",
        "Albums found in your current TIDAL library will appear here.",
      );
  $("#plans-list").innerHTML = state.plans.length
    ? `<table><thead><tr><th>Reference</th><th>Prepared</th><th>State</th><th>Albums</th><th></th></tr></thead><tbody>${state.plans.map((plan) => `<tr><td class="mono">${escapeHtml(plan.plan_id)}</td><td>${formatDate(plan.created_at)}</td><td><span class="badge ${plan.status === "completed" ? "safe" : ""}">${escapeHtml(titleCase(plan.status))}</span></td><td>${plan.addition_count}</td><td><button data-plan="${escapeAttr(plan.plan_id)}">Review</button></td></tr>`).join("")}</tbody></table>`
    : empty(
        "No additions have been prepared",
        "The history will appear after you review an exact set of additions.",
      );
  $$("[data-plan]").forEach((button) => {
    button.addEventListener("click", () => openPlan(button.dataset.plan));
  });
}

function additionRow(record) {
  const candidate = selectedCandidate(record);
  return `<article class="decision-item"><div><strong>${escapeHtml(record.artist)} - ${escapeHtml(record.title)}</strong><span>${escapeHtml((candidate?.tidal_artists ?? []).join(", ") || "TIDAL match")} - ${escapeHtml(candidate?.tidal_title ?? "Untitled")}</span></div><span class="badge ${record.alreadyInTidal ? "safe" : ""}">${record.alreadyInTidal ? "No action needed" : "Ready"}</span></article>`;
}

async function createPlan() {
  try {
    const result = await api("/api/plans", { method: "POST", body: "{}" });
    toast(
      result.reused
        ? "This exact addition was already prepared."
        : "Exact addition prepared. TIDAL was not changed.",
    );
    await refreshAll();
    showView("plans");
    await openPlan(result.plan.planId);
  } catch (error) {
    toast(error.message, true);
  }
}

async function openPlan(planId) {
  const plan = await api(`/api/plans/${encodeURIComponent(planId)}`);
  const payload = plan.payload;
  const canApply = plan.status === "proposed" && payload.additionCount > 0;
  $("#dialog-title").textContent = "Review exact addition";
  $("#plan-detail").innerHTML =
    `<div class="plan-summary">${detail("State", titleCase(plan.status))}${detail("Destination", "My TIDAL library")}${detail("Prepared", formatDate(plan.created_at))}${detail("Albums", payload.additionCount)}</div>
    <ol class="plan-items">${(payload.items ?? []).map((item) => `<li><span>${escapeHtml(item.artist)} - ${escapeHtml(item.title)}</span><small>${escapeHtml(item.tidalTitle || item.tidalAlbumId)}</small></li>`).join("") || "<li>No additions</li>"}</ol>
    <details class="technical-detail"><summary>Technical details</summary><p class="mono">Reference: ${escapeHtml(planId)}</p><a class="button" href="/api/plans/${encodeURIComponent(planId)}?download=1" download="${escapeAttr(planId)}.json">Download JSON</a></details>
    ${canApply ? `<div class="apply-boundary"><strong>Add these ${payload.additionCount} albums to TIDAL</strong><p>This is the only action on this screen that changes your TIDAL account.</p><label class="confirmation-check"><input id="apply-confirmation" type="checkbox" /><span>I understand that ${payload.additionCount} ${payload.additionCount === 1 ? "album will" : "albums will"} be added to my TIDAL library.</span></label><button id="apply-button" class="danger" type="button" disabled>Add these albums to TIDAL</button></div>` : `<div class="notice">This prepared addition cannot be used because it is ${escapeHtml(plan.status)} or contains no albums.</div>`}`;
  $("#apply-confirmation")?.addEventListener("change", (event) => {
    $("#apply-button").disabled = !event.target.checked;
  });
  $("#apply-button")?.addEventListener("click", () => applyPlan(planId));
  $("#plan-dialog").showModal();
}

async function applyPlan(planId) {
  try {
    await api(`/api/plans/${encodeURIComponent(planId)}/apply`, {
      method: "POST",
      body: JSON.stringify({ confirmed: $("#apply-confirmation").checked }),
    });
    $("#plan-dialog").close();
    toast("Apply started. Follow progress in Activity.");
    showView("activity");
    await refreshAll();
  } catch (error) {
    toast(error.message, true);
  }
}

function renderActivity() {
  $("#activity-list").innerHTML = state.activity.length
    ? state.activity
        .map(
          (event) =>
            `<article class="timeline-row"><span class="timeline-dot ${event.status}"></span><div><strong>${escapeHtml(activityName(event.kind))}</strong><p>${escapeHtml(event.summary)}</p>${activityError(event)}<small>${formatDate(event.createdAt)}</small></div><span class="badge ${event.status === "failed" ? "danger" : event.status === "completed" ? "safe" : "running"}">${event.status}</span></article>`,
        )
        .join("")
    : empty("No activity recorded", "Dashboard operations will appear here.");
}

function renderOperations(health, notification) {
  const schedule = state.dashboard.schedule;
  $("#schedule-enabled").checked = schedule.enabled;
  $("#schedule-interval").value = schedule.intervalMinutes;
  $("#schedule-next").textContent = schedule.enabled
    ? `Next run: ${formatDate(schedule.nextRunAt)}`
    : "Scheduling is paused.";
  $("#notification-enabled").checked = notification.enabled;
  $("#notification-target").textContent = notification.configured
    ? `Configured target: ${notification.target}`
    : "No webhook configured.";
  $("#health-details").innerHTML =
    detail("Status", health.status) +
    detail("Ready", health.ready ? "Yes" : "No") +
    detail("Active operation", health.activeOperation ?? "None") +
    detail("Database", health.database);
}

async function startScan() {
  try {
    await api("/api/operations/scan", { method: "POST", body: "{}" });
    toast("Read-only refresh started. Provider writes: 0.");
    await refreshLiveState();
  } catch (error) {
    toast(error.message, true);
  }
}
async function saveSchedule(event) {
  event.preventDefault();
  try {
    await api("/api/schedule", {
      method: "POST",
      body: JSON.stringify({
        enabled: $("#schedule-enabled").checked,
        intervalMinutes: Number($("#schedule-interval").value),
      }),
    });
    toast("Read-only schedule updated.");
    await refreshAll();
  } catch (error) {
    toast(error.message, true);
  }
}
async function saveNotification(event) {
  event.preventDefault();
  try {
    await api("/api/notifications", {
      method: "POST",
      body: JSON.stringify({
        enabled: $("#notification-enabled").checked,
        webhookUrl: $("#notification-url").value || undefined,
      }),
    });
    $("#notification-url").value = "";
    toast("Webhook notification updated.");
    await refreshAll();
  } catch (error) {
    toast(error.message, true);
  }
}
async function createBackup() {
  try {
    const result = await api("/api/backup", { method: "POST", body: "{}" });
    $("#backup-result").textContent = `Backup created: ${result.path}`;
    toast("Database backup created.");
    await refreshAll();
  } catch (error) {
    toast(error.message, true);
  }
}

function showView(name) {
  $$(".view").forEach((view) => {
    view.classList.toggle("active", view.id === `${name}-view`);
  });
  $$(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.view === name);
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
}
async function api(path, options = {}) {
  const headers = { Accept: "application/json", ...(options.headers ?? {}) };
  if (options.method && options.method !== "GET") {
    headers["Content-Type"] = "application/json";
    headers["X-CSRF-Token"] = state.csrf;
  }
  const response = await fetch(path, {
    ...options,
    headers,
    credentials: "same-origin",
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(body.error ?? `Request failed (${response.status})`);
  return body;
}
function metric(label, value, hint, tone = "") {
  return `<div class="metric ${tone}"><span>${escapeHtml(label)}</span><strong>${Number(value ?? 0).toLocaleString()}</strong><small>${escapeHtml(hint)}</small></div>`;
}
function detail(label, value) {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value ?? "-")}</dd></div>`;
}
function empty(title, copy) {
  return `<div class="empty"><strong>${escapeHtml(title)}</strong><p>${escapeHtml(copy)}</p></div>`;
}
function titleCase(value) {
  return String(value ?? "")
    .replaceAll("_", " ")
    .replace(/^./, (c) => c.toUpperCase());
}
function labelStatus(value) {
  return value === "needs_review" ? "Needs review" : titleCase(value);
}
function reviewState(record) {
  if (!record.decision)
    return ["needs_review", "low_confidence"].includes(record.status)
      ? "pending"
      : "automatic";
  if (record.decision.action === "approved")
    return record.alreadyInTidal ? "already_saved" : "ready_to_add";
  return record.decision.action;
}
function reviewStateLabel(value) {
  return (
    {
      pending: "Needs a decision",
      ready_to_add: "Approved - ready to add",
      already_saved: "Approved - already in TIDAL",
      deferred: "Deferred for later",
      unavailable: "Unavailable in TIDAL",
      rejected: "Rejected match",
    }[value] ?? labelStatus(value)
  );
}
function selectedCandidate(record) {
  const id = record.decision?.chosenTidalAlbumId;
  return (
    record.candidates?.find(
      (candidate) => String(candidate.tidal_album_id) === String(id),
    ) ?? record.bestMatch
  );
}
function activityName(kind) {
  return titleCase(String(kind).replace(".", " "));
}
function activityError(event) {
  if (event.status !== "failed" || !event.details?.error) return "";
  const lines = String(event.details.error)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const explicit = lines.find((line) => line.startsWith("error:"));
  const message = explicit?.slice("error:".length).trim() ?? lines[0];
  return message
    ? `<p class="activity-error">Reason: ${escapeHtml(message)}</p>`
    : "";
}
function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? String(value)
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}
function artworkFallback(record) {
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="#e4e1da"/><text x="48" y="54" text-anchor="middle" font-family="sans-serif" font-size="18" fill="#555">${escapeHtml(record.artist.slice(0, 2).toUpperCase())}</text></svg>`)}`;
}
function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>'"]/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[
        char
      ],
  );
}
function escapeAttr(value) {
  return escapeHtml(value);
}
function safeTidalUrl(value, albumId) {
  const fallback = `https://tidal.com/browse/album/${encodeURIComponent(String(albumId))}`;
  try {
    const url = new URL(String(value || fallback));
    if (
      url.protocol === "https:" &&
      (url.hostname === "tidal.com" || url.hostname.endsWith(".tidal.com"))
    )
      return url.href;
  } catch {
    // Fall back to the canonical album URL below.
  }
  return fallback;
}
function tidalArtworkUrl(albumId) {
  return `/api/artwork/tidal/${encodeURIComponent(String(albumId))}`;
}
function toast(message, error = false) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.toggle("error", error);
  element.classList.add("visible");
  setTimeout(() => element.classList.remove("visible"), 4200);
}
