const state = {
  csrfToken: "",
  records: [],
  filtered: [],
  selectedId: null,
  selectedCandidateId: null,
  pending: null,
  view: "queue",
};

const elements = {
  queue: document.querySelector("#queue"),
  detail: document.querySelector("#detail"),
  search: document.querySelector("#search"),
  status: document.querySelector("#status-filter"),
  score: document.querySelector("#score-filter"),
  summary: document.querySelector("#filter-summary"),
  queueCount: document.querySelector("#queue-count"),
  pendingCount: document.querySelector("#pending-count"),
  pendingList: document.querySelector("#pending-list"),
  libraryCount: document.querySelector("#library-count"),
  additionCount: document.querySelector("#addition-count"),
  toast: document.querySelector("#toast"),
  editDialog: document.querySelector("#edit-dialog"),
  editForm: document.querySelector("#edit-form"),
};

await initialize();

async function initialize() {
  try {
    const session = await getJson("/api/session");
    state.csrfToken = session.csrfToken;
    const [reviewData, pendingData] = await Promise.all([
      getJson("/api/reviews"),
      getJson("/api/pending"),
    ]);
    state.records = reviewData.records;
    state.pending = pendingData;
    bindEvents();
    applyFilters();
    renderPending();
  } catch (error) {
    renderFatal(error);
  }
}

function bindEvents() {
  elements.search.addEventListener("input", applyFilters);
  elements.status.addEventListener("change", applyFilters);
  elements.score.addEventListener("input", applyFilters);
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view));
  });
  elements.editForm.addEventListener("submit", saveMetadata);
  document
    .querySelector("#close-dialog")
    .addEventListener("click", () => elements.editDialog.close());
  document
    .querySelector("#cancel-edit")
    .addEventListener("click", () => elements.editDialog.close());
  document.addEventListener("keydown", (event) => {
    if (state.view !== "queue" || elements.editDialog.open) return;
    if (
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLSelectElement
    )
      return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(event.key === "ArrowDown" ? 1 : -1);
    }
  });
}

function applyFilters() {
  const query = elements.search.value.trim().toLowerCase();
  const status = elements.status.value;
  const minScore =
    elements.score.value === "" ? -Infinity : Number(elements.score.value);
  state.filtered = state.records.filter((record) => {
    const effectiveStatus = record.decision?.action ?? record.status;
    const reviewable =
      !record.decision &&
      ["needs_review", "low_confidence"].includes(record.status);
    const statusMatches =
      status === "all" ||
      (status === "reviewable" ? reviewable : effectiveStatus === status);
    const textMatches =
      !query ||
      `${record.artist} ${record.title} ${record.label}`
        .toLowerCase()
        .includes(query);
    return (
      statusMatches && textMatches && (record.score ?? -Infinity) >= minScore
    );
  });
  if (
    !state.filtered.some((record) => record.bandcampItemId === state.selectedId)
  ) {
    state.selectedId = state.filtered[0]?.bandcampItemId ?? null;
    state.selectedCandidateId = null;
  }
  renderQueue();
  renderDetail();
}

function renderQueue() {
  elements.queue.replaceChildren();
  elements.queueCount.textContent = String(state.filtered.length);
  elements.summary.textContent = `${state.filtered.length} of ${state.records.length} matches`;
  if (!state.filtered.length) {
    elements.queue.append(
      document.querySelector("#empty-template").content.cloneNode(true),
    );
    return;
  }
  for (const record of state.filtered) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `queue-item${record.bandcampItemId === state.selectedId ? " is-selected" : ""}`;
    button.setAttribute("role", "option");
    button.setAttribute(
      "aria-selected",
      String(record.bandcampItemId === state.selectedId),
    );
    button.dataset.id = String(record.bandcampItemId);
    button.append(artwork(record.artUrl, record.title, "queue-art"));
    const copy = document.createElement("span");
    copy.className = "queue-copy";
    copy.append(
      textElement("strong", record.title),
      textElement("span", record.artist),
      statusPill(record.decision?.action ?? record.status),
    );
    button.append(copy, textElement("span", record.score ?? "-", "score"));
    button.addEventListener("click", () => selectRecord(record.bandcampItemId));
    elements.queue.append(button);
  }
}

function renderDetail() {
  const record = selectedRecord();
  if (!record) {
    elements.detail.replaceChildren(
      document.querySelector("#empty-template").content.cloneNode(true),
    );
    return;
  }
  if (!state.selectedCandidateId) {
    state.selectedCandidateId =
      record.decision?.chosenTidalAlbumId ??
      String(
        record.bestMatch?.tidal_album_id ??
          record.candidates[0]?.tidal_album_id ??
          "",
      );
  }
  const root = document.createElement("div");
  root.className = "detail-content";
  const header = document.createElement("header");
  header.className = "source-header";
  header.append(artwork(record.artUrl, record.title, "source-art"));
  const source = document.createElement("div");
  source.className = "source-copy";
  source.append(
    textElement("span", "Bandcamp source", "eyebrow"),
    textElement("h1", record.title),
    textElement("h2", record.artist),
  );
  const line = document.createElement("div");
  line.className = "source-line";
  line.append(
    statusPill(record.decision?.action ?? record.status),
    textElement("span", `Score ${record.score ?? "-"}`),
    textElement("span", record.label || "No label hint"),
  );
  const sourceLink = link(record.url, "Open Bandcamp");
  if (sourceLink) line.append(sourceLink);
  source.append(line);
  const evidence = document.createElement("div");
  evidence.className = "evidence-block";
  evidence.append(
    textElement("span", "Why this score", "eyebrow"),
    textElement("p", record.explanation),
  );
  source.append(evidence);
  header.append(source);
  root.append(header);

  const heading = document.createElement("div");
  heading.className = "section-heading";
  heading.append(
    textElement("h2", "TIDAL candidates"),
    textElement("span", `${record.candidates.length} found`),
  );
  root.append(heading);
  const candidates = document.createElement("div");
  candidates.className = "candidate-list";
  if (!record.candidates.length)
    candidates.append(textElement("p", "No candidate albums were found."));
  record.candidates.forEach((candidate, index) => {
    candidates.append(candidateRow(candidate, index));
  });
  root.append(candidates, actionBar(record));
  elements.detail.replaceChildren(root);
}

function candidateRow(candidate, index) {
  const id = String(candidate.tidal_album_id ?? "");
  const label = document.createElement("label");
  label.className = `candidate${id === state.selectedCandidateId ? " is-chosen" : ""}`;
  const radio = document.createElement("input");
  radio.type = "radio";
  radio.name = "candidate";
  radio.value = id;
  radio.checked = id === state.selectedCandidateId;
  radio.addEventListener("change", () => {
    state.selectedCandidateId = id;
    renderDetail();
  });
  const copy = document.createElement("div");
  copy.className = "candidate-copy";
  const main = document.createElement("div");
  main.className = "candidate-main";
  const title = document.createElement("div");
  title.className = "candidate-title";
  const artists = Array.isArray(candidate.tidal_artists)
    ? candidate.tidal_artists.join(", ")
    : candidate.tidal_artist || "Unknown artist";
  title.append(
    textElement("strong", candidate.tidal_title || "Untitled"),
    textElement("span", artists),
  );
  main.append(
    title,
    textElement("span", candidate.score ?? "-", "candidate-score"),
  );
  const meta = document.createElement("div");
  meta.className = "candidate-meta";
  meta.append(
    textElement("span", candidate.tidal_album_type || "Unknown type"),
    textElement("span", candidate.tidal_release_date || "No release date"),
    textElement("span", `${candidate.tidal_track_count ?? "-"} tracks`),
    textElement("span", candidate.tidal_copyright || "No label data"),
  );
  copy.append(
    main,
    meta,
    textElement(
      "p",
      candidate.explanation || "No explanation recorded.",
      "candidate-explanation",
    ),
  );
  const candidateLink = link(
    candidate.tidal_url || `https://tidal.com/browse/album/${id}`,
    `Open TIDAL candidate ${index + 1}`,
    "candidate-link",
  );
  const candidateArtUrl =
    candidate.tidal_art_url ||
    candidate.tidal_image_url ||
    candidate.art_url ||
    candidate.image_url ||
    `/api/artwork/tidal/${id}`;
  label.append(
    radio,
    artwork(candidateArtUrl, candidate.tidal_title, "candidate-art"),
    copy,
  );
  if (candidateLink) label.append(candidateLink);
  return label;
}

function actionBar(record) {
  const bar = document.createElement("footer");
  bar.className = "detail-actions";
  const secondary = document.createElement("div");
  secondary.className = "action-group";
  secondary.append(
    actionButton("Edit", "text-button", () => openEdit(record)),
    actionButton("Defer", "text-button", () => decide("deferred")),
    actionButton("Unavailable", "text-button", () => decide("unavailable")),
  );
  const primary = document.createElement("div");
  primary.className = "action-group";
  primary.append(
    actionButton("Reject", "danger-button", () =>
      decide("rejected", state.selectedCandidateId),
    ),
    actionButton(
      "Approve selected",
      "primary-button",
      () => decide("approved", state.selectedCandidateId),
      !state.selectedCandidateId,
    ),
  );
  bar.append(secondary, primary);
  return bar;
}

async function decide(action, candidateId) {
  const record = selectedRecord();
  if (!record) return;
  try {
    await postJson(`/api/reviews/${record.bandcampItemId}`, {
      action,
      candidateId: candidateId || undefined,
    });
    showToast(`${capitalize(action)} decision saved. No TIDAL write was made.`);
    await refreshData();
  } catch (error) {
    showToast(error.message, true);
  }
}

function openEdit(record) {
  elements.editForm.elements.artist.value = record.artist;
  elements.editForm.elements.title.value = record.title;
  elements.editForm.elements.label.value = record.label;
  elements.editDialog.showModal();
}

async function saveMetadata(event) {
  event.preventDefault();
  const record = selectedRecord();
  if (!record) return;
  const data = new FormData(elements.editForm);
  try {
    await postJson(`/api/reviews/${record.bandcampItemId}`, {
      action: "edit",
      metadata: Object.fromEntries(data),
    });
    elements.editDialog.close();
    showToast("Metadata saved. No TIDAL write was made.");
    await refreshData();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function refreshData() {
  const [reviewData, pendingData] = await Promise.all([
    getJson("/api/reviews"),
    getJson("/api/pending"),
  ]);
  state.records = reviewData.records;
  state.pending = pendingData;
  applyFilters();
  renderPending();
}

function renderPending() {
  const plan = state.pending ?? {
    additions: [],
    additionCount: 0,
    currentLibraryCount: 0,
  };
  elements.pendingCount.textContent = String(plan.additionCount);
  elements.libraryCount.textContent = String(plan.currentLibraryCount);
  elements.additionCount.textContent = String(plan.additionCount);
  elements.pendingList.replaceChildren();
  if (!plan.additions.length) {
    elements.pendingList.append(
      document.querySelector("#empty-template").content.cloneNode(true),
    );
    return;
  }
  for (const record of plan.additions) {
    const row = document.createElement("div");
    row.className = "pending-row";
    row.append(
      artwork(record.artUrl, record.title),
      textElement("strong", `${record.artist} - ${record.title}`),
      textElement(
        "span",
        `TIDAL ${record.decision.chosenTidalAlbumId}`,
        "tidal-id",
      ),
      textElement("span", "+ add"),
    );
    elements.pendingList.append(row);
  }
}

function switchView(view) {
  state.view = view;
  document.querySelector("#queue-view").hidden = view !== "queue";
  document.querySelector("#pending-view").hidden = view !== "pending";
  document.querySelector(".filter-bar").hidden = view !== "queue";
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.view === view);
  });
}

function selectRecord(id) {
  state.selectedId = id;
  state.selectedCandidateId = null;
  renderQueue();
  renderDetail();
}

function moveSelection(delta) {
  if (!state.filtered.length) return;
  const current = state.filtered.findIndex(
    (record) => record.bandcampItemId === state.selectedId,
  );
  const next =
    (Math.max(0, current) + delta + state.filtered.length) %
    state.filtered.length;
  selectRecord(state.filtered[next].bandcampItemId);
  document
    .querySelector(`[data-id="${state.selectedId}"]`)
    ?.scrollIntoView({ block: "nearest" });
}

function selectedRecord() {
  return state.records.find(
    (record) => record.bandcampItemId === state.selectedId,
  );
}

function artwork(url, alt, className = "") {
  const image = document.createElement("img");
  image.className = className;
  image.alt = "";
  image.loading = "lazy";
  if (url) image.src = url;
  else image.src = placeholderDataUrl(alt);
  image.addEventListener(
    "error",
    () => {
      image.src = placeholderDataUrl(alt);
    },
    { once: true },
  );
  return image;
}

function placeholderDataUrl(value) {
  const initials = String(value || "?")
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] || "")
    .join("")
    .toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#e3e7e5"/><text x="80" y="88" text-anchor="middle" font-family="sans-serif" font-size="34" fill="#697071">${escapeXml(initials)}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function statusPill(status) {
  return textElement(
    "span",
    String(status).replaceAll("_", " "),
    `status-pill ${status}`,
  );
}
function textElement(tag, text, className = "") {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = String(text);
  return element;
}
function link(url, text, className = "") {
  if (!url) return null;
  let safeUrl;
  try {
    const parsed = new URL(url, window.location.origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return null;
    safeUrl = parsed.href;
  } catch {
    return null;
  }
  const anchor = textElement("a", text, className);
  anchor.href = safeUrl;
  anchor.target = "_blank";
  anchor.rel = "noreferrer noopener";
  return anchor;
}
function actionButton(text, className, handler, disabled = false) {
  const button = textElement("button", text, className);
  button.type = "button";
  button.disabled = disabled;
  button.addEventListener("click", handler);
  return button;
}
function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
function escapeXml(value) {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[char],
  );
}

async function getJson(url) {
  const response = await fetch(url, { credentials: "same-origin" });
  const body = await response.json();
  if (!response.ok)
    throw new Error(body.error || `Request failed: ${response.status}`);
  return body;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": state.csrfToken,
    },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error || `Request failed: ${response.status}`);
  if (result.providerWrites !== 0)
    throw new Error(
      "Safety invariant failed: provider write count is not zero.",
    );
  return result;
}

let toastTimer;
function showToast(message, error = false) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.className = `toast is-visible${error ? " is-error" : ""}`;
  toastTimer = setTimeout(() => {
    elements.toast.className = "toast";
  }, 3200);
}

function renderFatal(error) {
  elements.summary.textContent = "Could not load database";
  elements.detail.replaceChildren();
  const stateNode = document.createElement("div");
  stateNode.className = "empty-state";
  stateNode.append(
    textElement("h1", "Review desk unavailable"),
    textElement("p", error.message),
  );
  elements.detail.append(stateNode);
}
