// ── Tab switching ────────────────────────────────────────────────────
document.querySelectorAll(".nav-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".page").forEach(s => s.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(btn.dataset.tab).classList.add("active");
    if (btn.dataset.tab === "history") loadHistory();
  });
});

// ── Toast notifications ───────────────────────────────────────────────
function toast(msg, type = "info") {
  const container = document.getElementById("toast-container");
  const t = document.createElement("div");
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  container.appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => t.remove(), 300);
  }, 3500);
}

// ── Helpers ──────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  try {
    const res  = await fetch(path, opts);
    const data = await res.json();
    if (!res.ok) {
      toast(data.error || data.message || `Error ${res.status}`, "error");
      return null;
    }
    return data;
  } catch (e) {
    toast("Network error – is the server running?", "error");
    return null;
  }
}

function formatDate(iso) {
  if (!iso) return "--";
  return new Date(iso + "Z").toLocaleString();
}

function formatRelative(iso) {
  if (!iso) return null;
  const diff = Date.now() - new Date(iso + "Z").getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function esc(s) {
  if (!s) return "";
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

const SCHEDULE_LABELS = {
  "0 * * * *":   "Every hour",
  "0 */6 * * *": "Every 6 hours",
  "0 0 * * *":   "Daily at midnight",
  "0 2 * * *":   "Daily at 2:00 AM",
  "0 3 * * 1":   "Weekly (Mon 3 AM)",
  "0 4 1 * *":   "Monthly (1st at 4 AM)",
};

function scheduleLabel(cron) {
  if (!cron) return "Manual";
  return SCHEDULE_LABELS[cron] || cron;
}

// ── Schedule preset toggle ───────────────────────────────────────────
function onScheduleChange() {
  const sel    = document.getElementById("host-schedule-preset");
  const custom = document.getElementById("custom-cron-field");
  custom.style.display = sel.value === "custom" ? "block" : "none";
  if (sel.value !== "custom") {
    document.getElementById("host-schedule-custom").value = "";
  }
}

function getScheduleValue() {
  const preset = document.getElementById("host-schedule-preset").value;
  if (preset === "custom") return document.getElementById("host-schedule-custom").value.trim() || null;
  return preset || null;
}

// ── Live polling ─────────────────────────────────────────────────────
let pollingTimer   = null;
let runningHostIds = new Set();

function startPolling() {
  if (pollingTimer) return;
  pollingTimer = setInterval(pollRunning, 3000);
}

function stopPolling() {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
}

async function pollRunning() {
  let data;
  try {
    const res = await fetch("/api/history");
    data = await res.json();
  } catch (_) {
    return;
  }

  const stillRunning = new Set(
    data.filter(r => r.status === "running").map(r => r.host_id)
  );

  let needsHostRefresh = false;
  for (const id of runningHostIds) {
    if (!stillRunning.has(id)) {
      needsHostRefresh = true;
      const row    = data.find(r => r.host_id === id);
      const name   = row?.host_name || id;
      const status = row?.status;
      const count  = row?.files_deleted ?? 0;
      if (status === "success") toast(`✓ Cache cleared: ${name} — ${count} file${count !== 1 ? "s" : ""} deleted`, "success");
      else if (status === "failed") toast(`✗ Clear failed: ${name}`, "error");
    }
  }

  runningHostIds = stillRunning;

  if (needsHostRefresh) loadHosts();

  if (document.getElementById("history").classList.contains("active")) loadHistory();

  if (stillRunning.size === 0) stopPolling();
}

// ── Hosts ────────────────────────────────────────────────────────────
let hostsCache = [];

async function loadHosts() {
  const data = await api("/api/hosts");
  if (!data) return;
  hostsCache = data;
  renderHosts();

  const anyRunning = hostsCache.some(h => h.last_status === "running");
  if (anyRunning) {
    runningHostIds = new Set(hostsCache.filter(h => h.last_status === "running").map(h => h.id));
    startPolling();
  }
}

function hostCardHtml(h) {
  const paths = JSON.parse(h.remote_paths);
  const isRunning = h.last_status === "running";
  let lastBadge = "";
  if (isRunning) {
    lastBadge = `<span class="last-run-info" data-running-hostid="${h.id}">
      <span class="status status-running"><span class="spinner-inline"></span> running</span>
    </span>`;
  } else if (h.last_status) {
    const rel = formatRelative(h.last_run);
    const count = h.last_files_deleted ?? 0;
    lastBadge = `<span class="last-run-info">
      <span class="status status-${h.last_status}">${h.last_status}</span>
      ${rel ? `<span class="last-run-time">${rel}</span>` : ""}
      ${h.last_status === "success" ? `<span class="last-run-time">${count} file${count !== 1 ? "s" : ""}</span>` : ""}
    </span>`;
  } else {
    lastBadge = `<span class="last-run-info"><span class="never-run">Never cleared</span></span>`;
  }
  return `
  <div class="host-card${isRunning ? " host-card-running" : ""}">
    <div class="host-card-top">
      <div class="host-card-title">
        <h3>${esc(h.name)}</h3>
        ${lastBadge}
      </div>
      <div class="host-card-actions">
        <button class="btn btn-primary btn-sm" onclick="triggerClear(event, '${h.id}')"${isRunning ? " disabled" : ""}>
          ${isRunning ? '<span class="spinner-inline"></span> Running…' : "Clear Now"}
        </button>
        <button class="btn btn-sm btn-test" onclick="testConnection('${h.id}', this)">Test SSH</button>
        <button class="btn btn-sm" onclick="editHost('${h.id}')">Edit</button>
        <button class="btn btn-sm btn-danger" onclick="deleteHost('${h.id}')">Delete</button>
      </div>
    </div>
    <div class="host-meta">
      <span>${esc(h.username)}@${esc(h.hostname)}:${h.port}</span>
      <span>${scheduleLabel(h.schedule)}</span>
      <span>Keep: ${h.keep_last ? "last " + h.keep_last : "all"}</span>
    </div>
    <div class="tag-paths">
      ${paths.map(p => `<span class="tag">${esc(p)}</span>`).join("")}
    </div>
  </div>`;
}

function renderHosts() {
  const el = document.getElementById("host-list");
  if (!hostsCache.length) {
    el.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/>
          <circle cx="6" cy="6" r="1"/><circle cx="6" cy="18" r="1"/>
        </svg>
        <p>No hosts configured yet. Add one to get started.</p>
      </div>`;
    return;
  }

  const groups = {};
  const ungrouped = [];
  for (const h of hostsCache) {
    const g = h.grp ? h.grp.trim() : "";
    if (g) {
      if (!groups[g]) groups[g] = [];
      groups[g].push(h);
    } else {
      ungrouped.push(h);
    }
  }

  const sortedGroupNames = Object.keys(groups).sort((a, b) => a.localeCompare(b));
  let html = "";

  for (const gname of sortedGroupNames) {
    html += `<div class="host-group">
      <div class="host-group-header"><span class="host-group-label">${esc(gname)}</span></div>
      <div class="card-grid">${groups[gname].map(hostCardHtml).join("")}</div>
    </div>`;
  }

  if (ungrouped.length) {
    const wrap = sortedGroupNames.length ? `<div class="host-group">
      <div class="host-group-header"><span class="host-group-label host-group-ungrouped">Ungrouped</span></div>
      <div class="card-grid">${ungrouped.map(hostCardHtml).join("")}</div>
    </div>` : `<div class="card-grid">${ungrouped.map(hostCardHtml).join("")}</div>`;
    html += wrap;
  }

  el.innerHTML = html;
}

// ── Test SSH ─────────────────────────────────────────────────────────
async function testConnection(id, btn) {
  const orig = btn.textContent;
  btn.textContent = "Testing…";
  btn.disabled = true;
  const data = await api(`/api/test/${id}`, { method: "POST" });
  btn.textContent = orig;
  btn.disabled = false;
  if (!data) return;
  if (data.ok) toast("SSH connection successful", "success");
  else toast("Connection failed: " + data.message, "error");
}

// ── Path rows ────────────────────────────────────────────────────────
const PATH_PREFIX = "/opt/docker/";
const PATH_MID    = "/cache/";

function addPathRow(value = "") {
  const rowsEl = document.getElementById("path-rows");
  const row = document.createElement("div");
  row.className = "path-row";
  const safeVal = esc(value);
  row.innerHTML = `
    <span class="path-fixed">${PATH_PREFIX}</span>
    <input type="text" class="path-app-input" value="${safeVal}" placeholder="www-appbuilder"
           pattern="[A-Za-z0-9_-]+" required
           oninput="this.closest('.path-row').querySelector('.path-mirror').textContent = this.value || 'name'">
    <span class="path-fixed">${PATH_MID}</span>
    <span class="path-fixed path-mirror">${safeVal || 'name'}</span>
    <button type="button" class="btn-remove-path" onclick="this.closest('.path-row').remove()" title="Remove">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>`;
  rowsEl.appendChild(row);
}

function getAppNames() {
  return [...document.querySelectorAll(".path-app-input")]
    .map(i => i.value.trim())
    .filter(Boolean)
    .map(name => `${PATH_PREFIX}${name}${PATH_MID}${name}`);
}

// ── Host form ────────────────────────────────────────────────────────
function showHostForm(host) {
  document.getElementById("host-form-title").textContent = host ? "Edit Host" : "Add Host";
  document.getElementById("host-id").value       = host ? host.id : "";
  document.getElementById("host-name").value     = host ? host.name : "";
  document.getElementById("host-hostname").value = host ? host.hostname : "";
  document.getElementById("host-port").value     = host ? host.port : 22;
  document.getElementById("host-username").value = host ? host.username : "";
  document.getElementById("host-ssh-key").value  = host ? (host.ssh_key || "/root/.ssh/id_ed25519") : "/root/.ssh/id_ed25519";
  document.getElementById("host-group").value    = host ? (host.grp || "") : "";
  const appNames = host
    ? JSON.parse(host.remote_paths).map(p => {
        const m = p.match(/^\/opt\/docker\/([^/]+)\/cache\/\1$/);
        return m ? m[1] : p;
      })
    : [""];
  const rowsEl = document.getElementById("path-rows");
  rowsEl.innerHTML = "";
  appNames.forEach(name => addPathRow(name));
  document.getElementById("host-keep-last").value = host ? (host.keep_last || 0) : 0;

  const preset      = document.getElementById("host-schedule-preset");
  const customField = document.getElementById("custom-cron-field");
  const customInput = document.getElementById("host-schedule-custom");
  if (host && host.schedule) {
    const match = [...preset.options].find(o => o.value === host.schedule);
    if (match) {
      preset.value = host.schedule;
      customField.style.display = "none";
      customInput.value = "";
    } else {
      preset.value = "custom";
      customField.style.display = "block";
      customInput.value = host.schedule;
    }
  } else {
    preset.value = "";
    customField.style.display = "none";
    customInput.value = "";
  }

  document.getElementById("host-dialog").showModal();
}

function editHost(id) {
  const host = hostsCache.find(h => h.id === id);
  if (host) showHostForm(host);
}

async function saveHost(e) {
  e.preventDefault();
  const id    = document.getElementById("host-id").value;
  const paths = getAppNames();
  const data  = {
    name:         document.getElementById("host-name").value,
    hostname:     document.getElementById("host-hostname").value,
    port:         parseInt(document.getElementById("host-port").value),
    username:     document.getElementById("host-username").value,
    ssh_key:      document.getElementById("host-ssh-key").value.trim() || "/root/.ssh/id_ed25519",
    grp:          document.getElementById("host-group").value.trim(),
    remote_paths: paths,
    schedule:     getScheduleValue(),
    keep_last:    parseInt(document.getElementById("host-keep-last").value) || 0,
  };
  const result = id
    ? await api(`/api/hosts/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) })
    : await api("/api/hosts",       { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  if (!result) return;
  document.getElementById("host-dialog").close();
  toast(id ? "Host updated" : "Host added", "success");
  loadHosts();
}

async function deleteHost(id) {
  if (!confirm("Delete this host and its clear history?")) return;
  const result = await api(`/api/hosts/${id}`, { method: "DELETE" });
  if (!result) return;
  toast("Host deleted", "info");
  loadHosts();
}

async function triggerClear(e, id) {
  const host = hostsCache.find(h => h.id === id);
  const name = host?.name || id;
  if (!confirm(`Clear all files under the configured paths on "${name}"?\n\nThis will run:\nsudo find <path> -type f -exec rm -v {} \\;\n\nThis cannot be undone.`)) return;

  const btn = e.currentTarget;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-inline"></span> Starting…';
  const result = await api(`/api/clear/${id}`, { method: "POST" });
  if (!result) {
    btn.disabled = false;
    btn.textContent = "Clear Now";
    return;
  }
  btn.innerHTML = '<span class="spinner-inline"></span> Running…';
  toast("Cache clear started", "info");
  runningHostIds.add(id);
  startPolling();
}

// ── History ──────────────────────────────────────────────────────────
async function loadHistory() {
  const data = await api("/api/history");
  if (!data) return;
  const el = document.getElementById("history-list");
  if (!data.length) {
    el.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
        </svg>
        <p>No clears yet. Trigger one from the Hosts tab.</p>
      </div>`;
    return;
  }
  el.innerHTML = `
    <table class="history-table">
      <thead><tr><th>Host</th><th>Started</th><th>Duration</th><th>Files Deleted</th><th>Status</th></tr></thead>
      <tbody>
        ${data.map(r => {
          let duration = "--";
          if (r.started_at && r.finished_at) {
            const sec = Math.round((new Date(r.finished_at + "Z") - new Date(r.started_at + "Z")) / 1000);
            duration = sec < 60 ? sec + "s" : Math.floor(sec / 60) + "m " + (sec % 60) + "s";
          } else if (r.status === "running") {
            const sec = Math.round((Date.now() - new Date(r.started_at + "Z").getTime()) / 1000);
            duration = `${sec < 60 ? sec + "s" : Math.floor(sec / 60) + "m " + (sec % 60) + "s"} …`;
          }
          const count = r.files_deleted ?? "--";
          return `
          <tr>
            <td style="color:var(--text);font-weight:500">${esc(r.host_name)}</td>
            <td>${formatDate(r.started_at)}</td>
            <td>${duration}</td>
            <td>${count === "--" ? "--" : count + " file" + (count !== 1 ? "s" : "")}</td>
            <td><span class="status status-${r.status}">${r.status}</span></td>
          </tr>
          ${r.message ? `<tr><td colspan="5" class="error-msg">${esc(r.message)}</td></tr>` : ""}`;
        }).join("")}
      </tbody>
    </table>`;
}

// ── Init ─────────────────────────────────────────────────────────────
loadHosts();
