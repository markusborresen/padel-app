import {
  db, firebaseReady, getDocIdFromPin, sessionRef, generatePin6
} from "./firebase.js";
import { buildSchedule } from "./scheduler.js";
import {
  runTransaction, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";

/* ===== View switching ===== */
function showView(name) {
  for (const id of ["viewHome", "viewCreate", "viewJoin", "viewLoading"]) {
    document.getElementById(id).classList.toggle("active", id === name);
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

function updateServesInfo() {
  const pts = parseInt(document.getElementById('pointsPerRound').value, 10);
  const el = document.getElementById('servesInfo');
  if (!pts || pts < 1) { el.textContent = ''; return; }
  const serves = pts / 4;
  el.textContent = Number.isInteger(serves)
    ? `= ${serves} server per spiller`
    : `(ikke delelig med 4 – ulike server per spiller)`;
}

function updateMatchInfo() {
  const cellCount = document.querySelectorAll('#playerInputs .player-cell').length;
  const courts = parseInt(document.getElementById('createCourts').value, 10);
  const mode = document.getElementById('gameMode').value;
  const infoEl = document.getElementById('matchInfo');

  if (cellCount < 4) { infoEl.style.display = 'none'; return; }

  const N = cellCount;
  const courtsPerRound = Math.min(courts, Math.floor(N / 4));
  const numRounds = Math.min(Math.max(Math.ceil(N * (N - 1) / (4 * courtsPerRound)), 4), 20);

  let text = `${numRounds} runder`;
  if (mode === 'americano') {
    const pts = parseInt(document.getElementById('pointsPerRound').value, 10) || 32;
    const serves = pts / 4;
    text += ` · ${pts} poeng per runde · ${Number.isInteger(serves) ? serves : '~' + serves.toFixed(1)} server per spiller`;
  } else {
    const matchesPerPlayer = Math.round(numRounds * 4 * courtsPerRound / N);
    text += ` · ca. ${matchesPerPlayer} kamper per spiller`;
  }

  infoEl.style.display = 'block';
  infoEl.textContent = text;
}

function updatePlayerCount() {
  const cells = document.querySelectorAll('#playerInputs .player-cell');
  const n = cells.length;
  document.getElementById('playerCount').textContent = `${n} spillere`;

  // Enable/disable remove buttons (minimum 4)
  document.querySelectorAll('#playerInputs .player-remove')
    .forEach(btn => { btn.disabled = n <= 4; });

  updateMatchInfo();
}

function renumberCells() {
  document.querySelectorAll('#playerInputs .player-num')
    .forEach((el, i) => { el.textContent = i + 1; });
  document.querySelectorAll('#playerInputs .player-input')
    .forEach((el, i) => { if (!el.value) el.placeholder = `Spiller ${i + 1}`; });
}

function addPlayerCell(name = '') {
  const container = document.getElementById('playerInputs');
  const num = container.querySelectorAll('.player-cell').length + 1;

  const div = document.createElement('div');
  div.className = 'player-cell';
  div.innerHTML = `
    <span class="player-num">${num}</span>
    <input type="text" class="player-input" placeholder="Spiller ${num}"
           autocomplete="off" />
    <button type="button" class="player-remove" title="Fjern spiller" disabled>×</button>
  `;

  if (name) div.querySelector('.player-input').value = name;

  div.querySelector('.player-remove').addEventListener('click', () => {
    div.remove();
    renumberCells();
    updatePlayerCount();
  });
  div.querySelector('.player-input').addEventListener('input', updateMatchInfo);

  container.appendChild(div);
  updatePlayerCount();
  return div;
}

function initPlayerCells() {
  for (let i = 0; i < 4; i++) addPlayerCell();
}

/* ===== Helpers ===== */
function initScores(players) {
  const o = {};
  for (const p of players) o[p] = 0;
  return o;
}

/* ===== Create session ===== */
async function createSession(numCourts) {
  await firebaseReady;

  const players = getPlayerNames();
  if (players.length < 4) {
    alert("Du trenger minst 4 spillere med navn.");
    return;
  }

  showView("viewLoading");

  const seed = Date.now() >>> 0;
  const { rounds } = buildSchedule(players, numCourts, seed);

  if (!rounds.length) {
    alert("Klarte ikke å lage kampprogram. Sjekk antall spillere og baner.");
    showView("viewCreate");
    return;
  }

  const cycleLength = rounds.length;
  const mode = document.getElementById('gameMode').value;
  const pointsPerRound = mode === 'americano'
    ? (parseInt(document.getElementById('pointsPerRound').value, 10) || 32)
    : 0;

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
          cycleLength,
          mode,
          pointsPerRound,
          currentRound: 0,
          winners: {},
          scores: initScores(players),
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
      alert(err?.message || "Noe gikk galt. Prøv igjen.");
      showView("viewCreate");
      return;
    }
  }

  alert("Klarte ikke å generere unik PIN. Prøv igjen.");
  showView("viewCreate");
}

/* ===== Wiring ===== */
window.addEventListener("load", () => {
  initPlayerCells();

  document.getElementById("goCreateBtn").addEventListener("click", () => {
    showView("viewCreate");
    updateMatchInfo();
  });
  document.getElementById("goJoinBtn").addEventListener("click", () => showView("viewJoin"));
  document.getElementById("createBackBtn").addEventListener("click", () => showView("viewHome"));
  document.getElementById("joinBackBtn").addEventListener("click", () => showView("viewHome"));

  document.getElementById("addPlayerBtn").addEventListener("click", () => {
    addPlayerCell();
    const inputs = document.querySelectorAll('#playerInputs .player-input');
    inputs[inputs.length - 1]?.focus();
  });

  document.getElementById("createCourts").addEventListener("change", updateMatchInfo);

  document.getElementById("gameMode").addEventListener("change", () => {
    const isAmericano = document.getElementById('gameMode').value === 'americano';
    document.getElementById('americanoOptions').style.display = isAmericano ? 'block' : 'none';
    updateServesInfo();
    updateMatchInfo();
  });

  document.getElementById("pointsPerRound").addEventListener("input", () => {
    updateServesInfo();
    updateMatchInfo();
  });

  document.getElementById("createStartBtn").addEventListener("click", async () => {
    const courts = parseInt(document.getElementById("createCourts").value, 10);
    await createSession(courts);
  });

  document.getElementById("joinStartBtn").addEventListener("click", () => {
    const pin = document.getElementById("joinPin").value.trim();
    if (!pin) { alert("Skriv inn PIN."); return; }
    window.location.href = `./match.html#pin=${pin}`;
  });
});
