import {
  db, firebaseReady, getDocIdFromPin, sessionRef, generatePin6
} from "./firebase.js";
import { buildSchedule, courtsInUse, matchesPerCycle } from "./scheduler.js";
import {
  runTransaction, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";

const el = id => document.getElementById(id);

/* ===== View switching ===== */
function showView(name) {
  for (const id of ["viewHome", "viewCreate", "viewJoin", "viewLoading"]) {
    el(id).classList.toggle("active", id === name);
  }
}

/* ===== Player cells ===== */
function getPlayerNames() {
  const names = [];
  const seen = new Set();
  for (const input of document.querySelectorAll('#playerInputs .player-input')) {
    const name = input.value.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

// Up to 7 players → 1 court, up to 15 → 2, up to 23 → 3, …
function suggestedCourts(n) {
  return Math.max(1, Math.min(Math.floor(n / 8) + 1, Math.floor(n / 4), 6));
}

function getPointsPerRound() {
  return parseInt(el('pointsPerRound').value, 10) || 21;
}

function updateMatchInfo() {
  const N = document.querySelectorAll('#playerInputs .player-cell').length;
  const courts = parseInt(el('createCourts').value, 10);
  const c = courtsInUse(N, courts);
  const R = matchesPerCycle(N, c);
  const resting = N - c * 4;

  let text = `${R} kamper – alle spiller på lag med alle minst én gang`;
  if (resting > 0) text += ` · ${resting} hviler per kamp`;
  if ((R * c * 4) % N !== 0) text += ` · noen spiller én kamp mer enn andre`;
  if (courts > c) text += ` · kun ${c} bane${c > 1 ? 'r' : ''} i bruk`;
  el('servesInfo').textContent = text;
}

// Mobile keyboards don't always re-enable caps when focus moves via Enter
function capitalizeFirst(input) {
  const v = input.value;
  if (v.length === 1 && v !== v.toUpperCase()) input.value = v.toUpperCase();
}

function updatePlayerCount() {
  const n = document.querySelectorAll('#playerInputs .player-cell').length;
  el('playerCount').textContent = `${n} spillere`;

  // Minimum 4 players
  document.querySelectorAll('#playerInputs .player-remove')
    .forEach(btn => { btn.disabled = n <= 4; });

  el('createCourts').value = String(suggestedCourts(n));
  updateMatchInfo();
}

function renumberCells() {
  document.querySelectorAll('#playerInputs .player-num')
    .forEach((e, i) => { e.textContent = i + 1; });
  document.querySelectorAll('#playerInputs .player-input')
    .forEach((e, i) => { e.placeholder = `Spiller ${i + 1}`; });
}

function addPlayerCell() {
  const container = el('playerInputs');
  const num = container.querySelectorAll('.player-cell').length + 1;

  const div = document.createElement('div');
  div.className = 'player-cell';
  div.innerHTML = `
    <span class="player-num">${num}</span>
    <input type="text" class="player-input" placeholder="Spiller ${num}"
           autocomplete="off" autocapitalize="words" enterkeyhint="next" />
    <button type="button" class="player-remove" title="Fjern spiller" disabled>×</button>
  `;

  const input = div.querySelector('.player-input');
  input.addEventListener('input', () => capitalizeFirst(input));
  div.querySelector('.player-remove').addEventListener('click', () => {
    div.remove();
    renumberCells();
    updatePlayerCount();
  });

  // Enter → next field; on the last filled field, add a new one
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const inputs = [...container.querySelectorAll('.player-input')];
    const next = inputs[inputs.indexOf(input) + 1];
    if (next) next.focus();
    else if (input.value.trim()) addPlayerCell().querySelector('.player-input').focus();
  });

  container.appendChild(div);
  updatePlayerCount();
  return div;
}

/* ===== Create session ===== */
async function createSession() {
  const players = getPlayerNames();
  if (players.length < 4) {
    alert("Du trenger minst 4 spillere med navn.");
    return;
  }

  showView("viewLoading");

  try {
    await firebaseReady;
  } catch (err) {
    console.error(err);
    alert("Klarte ikke å koble til serveren. Sjekk nettet og prøv igjen.\n\n" + (err?.message || err));
    showView("viewCreate");
    return;
  }

  // Let the loading view paint before the (blocking) optimizer runs
  await new Promise(r => setTimeout(r, 30));

  const numCourts = parseInt(el("createCourts").value, 10);
  const { rounds } = buildSchedule(players, numCourts, Date.now() >>> 0);

  if (!rounds.length) {
    alert("Klarte ikke å lage kampprogram. Sjekk antall spillere og baner.");
    showView("viewCreate");
    return;
  }

  for (let attempt = 0; attempt < 10; attempt++) {
    const pin = generatePin6();
    const docId = await getDocIdFromPin(pin);
    const ref = sessionRef(docId);

    try {
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        if (snap.exists()) throw new Error("PIN_COLLISION");

        tx.set(ref, {
          pin,
          players,
          numCourts,
          rounds,
          cycleLength: rounds.length,
          mode: "americano",
          pointsPerRound: getPointsPerRound(),
          currentRound: 0,
          winners: {},
          scores: Object.fromEntries(players.map(p => [p, 0])),
          status: "active",
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        }, { merge: false });
      });

      window.location.href = `./match.html#pin=${pin}`;
      return;
    } catch (err) {
      if ((err?.message || "") === "PIN_COLLISION") continue;
      console.error(err);
      alert("Klarte ikke å opprette kampen: " + (err?.message || err));
      showView("viewCreate");
      return;
    }
  }

  alert("Klarte ikke å generere unik PIN. Prøv igjen.");
  showView("viewCreate");
}

/* ===== Wiring (module scripts run after the DOM is parsed) ===== */
for (let i = 0; i < 4; i++) addPlayerCell();

el("goCreateBtn").addEventListener("click", () => {
  showView("viewCreate");
  document.querySelector('#playerInputs .player-input')?.focus();
});
el("goJoinBtn").addEventListener("click", () => showView("viewJoin"));
el("createBackBtn").addEventListener("click", () => showView("viewHome"));
el("joinBackBtn").addEventListener("click", () => showView("viewHome"));

el("addPlayerBtn").addEventListener("click", () => {
  addPlayerCell().querySelector('.player-input').focus();
});

el("createCourts").addEventListener("change", updateMatchInfo);
el("pointsPerRound").addEventListener("input", updateMatchInfo);
el("createStartBtn").addEventListener("click", createSession);

el("joinStartBtn").addEventListener("click", () => {
  const pin = el("joinPin").value.trim();
  if (!pin) { alert("Skriv inn PIN."); return; }
  window.location.href = `./match.html#pin=${pin}`;
});
