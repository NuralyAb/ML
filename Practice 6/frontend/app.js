const ALMATY = [43.238949, 76.889709];

const state = {
  pickMode: "from",
  from: null,
  to: null,
  fromMarker: null,
  toMarker: null,
  line: null,
  distanceKm: null,
  appMode: "predict",
  lastPayload: null,
  lastPrediction: null,
};

const map = L.map("map").setView(ALMATY, 12);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

const fromIcon = L.divIcon({
  className: "pin",
  html: "<div style='background:#10b981;color:#fff;padding:4px 8px;border-radius:50%;font-weight:700;box-shadow:0 0 0 3px #064e3b'>A</div>",
  iconSize: [28, 28],
  iconAnchor: [14, 14],
});
const toIcon = L.divIcon({
  className: "pin",
  html: "<div style='background:#ef4444;color:#fff;padding:4px 8px;border-radius:50%;font-weight:700;box-shadow:0 0 0 3px #7f1d1d'>B</div>",
  iconSize: [28, 28],
  iconAnchor: [14, 14],
});

const modeButtons = document.querySelectorAll(".mode-btn");
const toggleButtons = document.querySelectorAll(".toggle-btn");
const distanceLabel = document.getElementById("distanceLabel");
const distanceSource = document.getElementById("distanceSource");
const resetBtn = document.getElementById("resetBtn");

const predictForm = document.getElementById("predictForm");
const reverseForm = document.getElementById("reverseForm");
const submitBtn = document.getElementById("submitBtn");
const reverseBtn = document.getElementById("reverseBtn");
const datetimeInput = document.getElementById("departureDatetime");
const arrivalInput = document.getElementById("arrivalDatetime");
const datetimeHint = document.getElementById("datetimeHint");
const durationInput = document.getElementById("targetDuration");
const durationValue = document.getElementById("durationValue");
const thresholdInput = document.getElementById("thresholdInput");
const thresholdValue = document.getElementById("thresholdValue");
const resultBox = document.getElementById("result");
const feedbackBox = document.getElementById("feedbackBox");

const fbTotal = document.getElementById("fbTotal");
const fbAgreement = document.getElementById("fbAgreement");
const fbOnTime = document.getElementById("fbOnTime");
function setPickMode(mode) {
  state.pickMode = mode;
  modeButtons.forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
}

function markPickDone(mode) {
  const btn = [...modeButtons].find((b) => b.dataset.mode === mode);
  if (btn) {
    btn.classList.remove("active");
    btn.classList.add("done");
  }
}

function formatLocalDatetime(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function updateDatetimeHint() {
  if (!datetimeInput.value) {
    datetimeHint.textContent = "";
    return;
  }
  const d = new Date(datetimeInput.value);
  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const dow = (d.getDay() + 6) % 7;
  const hour = d.getHours();
  const isPeak = (hour >= 8 && hour <= 10) || (hour >= 17 && hour <= 20);
  datetimeHint.textContent = `${days[dow]} at ${String(hour).padStart(2, "0")}:00${isPeak ? " - peak hours" : ""}`;
}

function updateSubmitState() {
  const needDistance = state.distanceKm != null;
  submitBtn.disabled = !(needDistance && datetimeInput.value);
  reverseBtn.disabled = !(needDistance && arrivalInput.value);
}

async function fetchDistance() {
  try {
    distanceLabel.textContent = "calculating...";
    const resp = await fetch("/distance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from_lat: state.from[0],
        from_lon: state.from[1],
        to_lat: state.to[0],
        to_lon: state.to[1],
      }),
    });
    const data = await resp.json();
    state.distanceKm = data.distance_km;
    distanceLabel.textContent = `${data.distance_km} km`;
    distanceSource.textContent = `via ${data.source}`;

    if (state.line) map.removeLayer(state.line);
    const pathPoints = data.geometry && data.geometry.length > 1
      ? data.geometry
      : [state.from, state.to];
    const dashed = !data.geometry || data.geometry.length < 2;
    state.line = L.polyline(pathPoints, {
      color: "#fbbf24",
      weight: 4,
      opacity: 0.9,
      dashArray: dashed ? "6 8" : null,
    }).addTo(map);
    map.fitBounds(state.line.getBounds(), { padding: [30, 30] });

    if (data.distance_km > 25) {
      distanceSource.textContent += " (>25 km, model only trained up to 25)";
    }
    updateSubmitState();
  } catch (e) {
    distanceLabel.textContent = "error";
    console.error(e);
  }
}

map.on("click", (ev) => {
  const { lat, lng } = ev.latlng;
  if (state.pickMode === "from") {
    state.from = [lat, lng];
    if (state.fromMarker) map.removeLayer(state.fromMarker);
    state.fromMarker = L.marker([lat, lng], { icon: fromIcon }).addTo(map);
    markPickDone("from");
    setPickMode("to");
  } else {
    state.to = [lat, lng];
    if (state.toMarker) map.removeLayer(state.toMarker);
    state.toMarker = L.marker([lat, lng], { icon: toIcon }).addTo(map);
    markPickDone("to");
  }
  if (state.from && state.to) fetchDistance();
});

resetBtn.addEventListener("click", () => {
  if (state.fromMarker) map.removeLayer(state.fromMarker);
  if (state.toMarker) map.removeLayer(state.toMarker);
  if (state.line) map.removeLayer(state.line);
  state.from = state.to = state.distanceKm = null;
  state.fromMarker = state.toMarker = state.line = null;
  distanceLabel.textContent = "-";
  distanceSource.textContent = "";
  modeButtons.forEach((b) => b.classList.remove("done"));
  setPickMode("from");
  updateSubmitState();
  resultBox.classList.add("hidden");
  feedbackBox.classList.add("hidden");
});

datetimeInput.addEventListener("change", () => {
  updateDatetimeHint();
  updateSubmitState();
});
arrivalInput.addEventListener("change", updateSubmitState);

durationInput.addEventListener("input", () => { durationValue.textContent = durationInput.value; });
thresholdInput.addEventListener("input", () => { thresholdValue.textContent = thresholdInput.value; });

datetimeInput.value = formatLocalDatetime(new Date());
arrivalInput.value = formatLocalDatetime(new Date(Date.now() + 45 * 60 * 1000));
updateDatetimeHint();

toggleButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    toggleButtons.forEach((b) => b.classList.toggle("active", b === btn));
    state.appMode = btn.dataset.appmode;
    if (state.appMode === "predict") {
      predictForm.classList.remove("hidden");
      reverseForm.classList.add("hidden");
    } else {
      reverseForm.classList.remove("hidden");
      predictForm.classList.add("hidden");
    }
    resultBox.classList.add("hidden");
    feedbackBox.classList.add("hidden");
  });
});

predictForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (state.distanceKm == null) return;

  const distance = Math.min(Math.max(state.distanceKm, 1), 25);
  const transport = document.querySelector("input[name=transport]:checked").value;
  const payload = {
    distance_km: distance,
    departure_datetime: datetimeInput.value,
    target_duration_min: Number(durationInput.value),
    transport_type: transport,
  };

  submitBtn.disabled = true;
  submitBtn.textContent = "Predicting...";

  try {
    const resp = await fetch("/predict", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) throw new Error(await resp.text());
    const data = await resp.json();
    state.lastPayload = payload;
    state.lastPrediction = data;
    renderPrediction(data, distance);
    feedbackBox.classList.remove("hidden");
    feedbackBox.querySelectorAll(".fb-btn").forEach((b) => b.classList.remove("saved"));
  } catch (e) {
    resultBox.className = "result info";
    resultBox.innerHTML = `<h3>Error</h3><div class="details">${e.message}</div>`;
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Predict";
  }
});

reverseForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (state.distanceKm == null) return;

  const distance = Math.min(Math.max(state.distanceKm, 1), 25);
  const transport = document.querySelector("input[name=transportR]:checked").value;
  const threshold = Number(thresholdInput.value);

  reverseBtn.disabled = true;
  reverseBtn.textContent = "Searching...";

  try {
    const resp = await fetch("/latest-departure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        arrival_datetime: arrivalInput.value,
        distance_km: distance,
        transport_type: transport,
        threshold,
      }),
    });
    if (!resp.ok) throw new Error(await resp.text());
    const data = await resp.json();
    renderReverse(data, distance);
    feedbackBox.classList.add("hidden");
  } catch (e) {
    resultBox.className = "result info";
    resultBox.innerHTML = `<h3>Error</h3><div class="details">${e.message}</div>`;
  } finally {
    reverseBtn.disabled = false;
    reverseBtn.textContent = "Find latest departure";
  }
});

function renderPrediction(data, distanceUsed) {
  const cls = data.on_time ? "on-time" : "late";
  const headline = data.on_time ? "Likely ON TIME" : "Likely LATE";
  const d = data.derived || {};
  const probaPct = data.probability_on_time != null
    ? (data.probability_on_time * 100).toFixed(1) + "%"
    : "n/a";
  resultBox.className = `result ${cls}`;
  resultBox.innerHTML = `
    <h3>${headline}</h3>
    <div class="proba">p(on time) = ${probaPct}</div>
    <div class="details">
      Distance: ${distanceUsed} km &middot;
      Hour: ${d.departure_hour} &middot;
      Day idx: ${d.day_of_week} &middot;
      Peak: ${d.is_peak_hour ? "yes" : "no"}
    </div>
  `;
}

function renderReverse(data, distanceUsed) {
  const rec = data.recommended;
  const cls = data.feasible_at_threshold ? "on-time" : "late";
  const headline = data.feasible_at_threshold
    ? `Leave at ${rec.departure.slice(11)}`
    : `Can't hit ${(data.threshold * 100).toFixed(0)}% confidence`;
  resultBox.className = `result ${cls}`;
  resultBox.innerHTML = `
    <h3>${headline}</h3>
    <div class="details">
      Buffer: ${rec.buffer_min} min &middot;
      Distance: ${distanceUsed} km &middot;
      Peak: ${rec.is_peak_hour ? "yes" : "no"}<br />
      ${data.note || ""}
    </div>
  `;
}

feedbackBox.querySelectorAll(".fb-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    if (!state.lastPayload || !state.lastPrediction) return;
    if (btn.classList.contains("saved")) return;

    const actual = btn.dataset.actual === "1";
    try {
      const resp = await fetch("/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...state.lastPayload,
          predicted_on_time: state.lastPrediction.on_time,
          actual_on_time: actual,
        }),
      });
      if (!resp.ok) throw new Error(await resp.text());
      feedbackBox.querySelectorAll(".fb-btn").forEach((b) => b.classList.add("saved"));
      refreshStats();
    } catch (e) {
      alert("Failed to save feedback: " + e.message);
    }
  });
});

async function refreshStats() {
  try {
    const resp = await fetch("/feedback/stats");
    const s = await resp.json();
    fbTotal.textContent = s.total ?? 0;
    fbAgreement.textContent = s.agreement != null ? (s.agreement * 100).toFixed(0) + "%" : "-";
    fbOnTime.textContent = s.on_time_rate != null ? (s.on_time_rate * 100).toFixed(0) + "%" : "-";
  } catch (e) {
    console.warn(e);
  }
}

refreshStats();
