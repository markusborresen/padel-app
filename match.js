import {
  db, firebaseReady, getDocIdFromPin, sessionRef, historyCol
} from "./firebase.js";
import {
  onSnapshot, runTransaction, updateDoc, addDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";

/* ===== State ===== */
let CURRENT_PIN = "";
let CURRENT_DOC_ID = null;
let unsubscribe = null;

let PLAYERS = [];
let ROUNDS = [];
let CURRENT_ROUND = 0;
let WINNERS = {};
let SCORES = {};
let STATUS = "active";

/* ===== DOM helpers ===== */
const el = id => document.getElementById(id);

function setDisabled(disabled) {
  el("endSessionBtn").disabled = disabled;
  el("prevRoundBtn").disabled = disabled;
  el("nextRoundBtn").disabled = disabled;
  el("courtsContainer").querySelectorAll("input").forEach(i => i.disabled = disabled);
}

/* ===== Rendering ===== */
function renderRoundNav() {
  el("roundTitle").textContent = `Runde ${CURRENT_ROUND + 1} av ${ROUNDS.length}`;
  el("prevRoundBtn").disabled = CURRENT_ROUND <= 0 || STATUS === "completed";
  el("nextRoundBtn").disabled = CURRENT_ROUND >= ROUNDS.length - 1 || STATUS === "completed";
}

function renderCurrentRound() {
  const container = el("courtsContainer");
  container.innerHTML = "";

  const round = ROUNDS[CURRENT_ROUND] || [];
  const activePlayers = new Set();

  round.forEach((match, courtIdx) => {
    activePlayers.add(match.a[0]); activePlayers.add(match.a[1]);
    activePlayers.add(match.b[0]); activePlayers.add(match.b[1]);

    const winnerKey = `${CURRENT_ROUND}:${courtIdx}`;
    const currentWinner = WINNERS[winnerKey] || null;

    const idA = `w_${CURRENT_ROUND}_${courtIdx}_A`;
    const idB = `w_${CURRENT_ROUND}_${courtIdx}_B`;
    const name = `w_${CURRENT_ROUND}_${courtIdx}`;

    const card = document.createElement("div");
    card.className = "court-card";
    card.innerHTML = `
      <div class="court-label">Bane ${courtIdx + 1}</div>
      <div class="teams">
        <span class="team">${match.a[0]} &amp; ${match.a[1]}</span>
        <span class="vs">vs</span>
        <span class="team">${match.b[0]} &amp; ${match.b[1]}</span>
      </div>
      <div class="winseg" role="group" aria-label="Vinner bane ${courtIdx + 1}">
        <input class="winradio" type="radio" name="${name}" id="${idA}" value="A"
          ${currentWinner === "A" ? "checked" : ""}
          ${STATUS === "completed" ? "disabled" : ""}>
        <label class="winbtn" for="${idA}">A</label>
        <input class="winradio" type="radio" name="${name}" id="${idB}" value="B"
          ${currentWinner === "B" ? "checked" : ""}
          ${STATUS === "completed" ? "disabled" : ""}>
        <label class="winbtn" for="${idB}">B</label>
      </div>
    `;
    container.appendChild(card);
  });

  // Resting players
  const resting = PLAYERS.filter(p => !activePlayers.has(p));
  el("restingLine").textContent = resting.length
    ? `Hviler: ${resting.join(", ")}`
    : "";
}

function renderScores() {
  const entries = Object.entries(SCORES).sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
  el("scores").innerHTML = entries
    .map(([p, pts]) => `<div class="score-row"><span class="pill">${pts}</span>${p}</div>`)
    .join("");
}

function hydrate(data) {
  PLAYERS = data.players || [];
  ROUNDS = data.rounds || [];
  CURRENT_ROUND = data.currentRound ?? 0;
  WINNERS = data.winners || {};
  SCORES = data.scores || {};
  STATUS = data.status || "active";

  el("loadingMsg").style.display = "none";
  el("mainContent").style.display = "block";

  if (STATUS === "completed") {
    el("completedBanner").style.display = "block";
    el("endSessionBtn").style.display = "none";
  }

  renderRoundNav();
  renderCurrentRound();
  renderScores();
}

/* ===== Firestore ops ===== */
async function setWinner(roundIdx, courtIdx, newWinner) {
  if (!CURRENT_DOC_ID) return;

  await runTransaction(db, async (tx) => {
    const ref = sessionRef(CURRENT_DOC_ID);
    const snap = await tx.get(ref);
    if (!snap.exists()) return;

    const data = snap.data();
    const round = (data.rounds || [])[roundIdx] || [];
    const match = round[courtIdx];
    if (!match) return;

    const winners = { ...(data.winners || {}) };
    const scores = { ...(data.scores || {}) };
    const key = `${roundIdx}:${courtIdx}`;
    const prev = winners[key] || null;

    const applyDelta = (team, delta) => {
      scores[team[0]] = (scores[team[0]] || 0) + delta;
      scores[team[1]] = (scores[team[1]] || 0) + delta;
    };

    if (prev === "A") applyDelta(match.a, -1);
    if (prev === "B") applyDelta(match.b, -1);
    if (newWinner === "A") applyDelta(match.a, +1);
    if (newWinner === "B") applyDelta(match.b, +1);

    winners[key] = newWinner;
    tx.update(ref, { winners, scores, updatedAt: serverTimestamp() });
  });
}

async function goToRound(idx) {
  if (!CURRENT_DOC_ID) return;
  await updateDoc(sessionRef(CURRENT_DOC_ID), {
    currentRound: idx,
    updatedAt: serverTimestamp(),
  });
}

async function endSession() {
  if (!CURRENT_DOC_ID) return;
  if (!confirm("Avslutte sesjonen og lagre resultatet til statistikk?")) return;

  // Compute totalMatches per player (how many matches they appeared in)
  const totalMatches = {};
  for (const p of PLAYERS) totalMatches[p] = 0;
  for (const round of ROUNDS) {
    for (const match of round) {
      for (const p of [...match.a, ...match.b]) {
        totalMatches[p] = (totalMatches[p] || 0) + 1;
      }
    }
  }

  try {
    // Write history doc
    await addDoc(historyCol(), {
      pin: CURRENT_PIN,
      players: PLAYERS,
      numCourts: ROUNDS[0]?.length || 1,
      rounds: ROUNDS,
      winners: WINNERS,
      finalScores: { ...SCORES },
      totalMatches,
      completedAt: serverTimestamp(),
    });

    // Mark session completed
    await updateDoc(sessionRef(CURRENT_DOC_ID), {
      status: "completed",
      updatedAt: serverTimestamp(),
    });

    window.location.href = "./stats.html";
  } catch (err) {
    console.error(err);
    alert("Noe gikk galt. Prøv igjen.");
  }
}

function leave() {
  if (unsubscribe) unsubscribe();
  window.location.href = "./index.html";
}

/* ===== Init ===== */
async function init() {
  await firebaseReady;

  const hash = window.location.hash; // e.g. "#pin=123456"
  const match = hash.match(/[#&]pin=(\d+)/);
  if (!match) {
    el("loadingMsg").textContent = "Ingen PIN funnet. Gå tilbake og prøv igjen.";
    return;
  }

  CURRENT_PIN = match[1];
  el("pinDisplay").textContent = `PIN: ${CURRENT_PIN}`;
  CURRENT_DOC_ID = await getDocIdFromPin(CURRENT_PIN);

  unsubscribe = onSnapshot(sessionRef(CURRENT_DOC_ID), (snap) => {
    if (!snap.exists()) {
      el("loadingMsg").textContent = "Fant ingen sesjon med denne PIN-en.";
      el("loadingMsg").style.display = "block";
      el("mainContent").style.display = "none";
      return;
    }
    hydrate(snap.data());
  });
}

/* ===== Event wiring ===== */
window.addEventListener("load", () => {
  // Winner radio buttons (delegated)
  document.addEventListener("change", async (e) => {
    const input = e.target;
    if (!input?.name?.startsWith("w_")) return;
    const parts = input.name.split("_"); // ["w", roundIdx, courtIdx]
    const roundIdx = parseInt(parts[1], 10);
    const courtIdx = parseInt(parts[2], 10);
    if (!Number.isFinite(roundIdx) || !Number.isFinite(courtIdx)) return;
    if (input.value !== "A" && input.value !== "B") return;
    try { await setWinner(roundIdx, courtIdx, input.value); }
    catch (err) { console.error(err); }
  });

  el("prevRoundBtn").addEventListener("click", async () => {
    if (CURRENT_ROUND > 0) await goToRound(CURRENT_ROUND - 1);
  });
  el("nextRoundBtn").addEventListener("click", async () => {
    if (CURRENT_ROUND < ROUNDS.length - 1) await goToRound(CURRENT_ROUND + 1);
  });

  el("copyPinBtn").addEventListener("click", async () => {
    if (!CURRENT_PIN) return;
    try {
      await navigator.clipboard.writeText(CURRENT_PIN);
    } catch {
      prompt("Kopier PIN:", CURRENT_PIN);
    }
  });

  el("endSessionBtn").addEventListener("click", endSession);
  el("leaveBtn").addEventListener("click", leave);

  init();
});
