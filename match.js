import {
  db, firebaseReady, getDocIdFromPin, sessionRef, historyCol
} from "./firebase.js";
import { buildExtraRounds } from "./scheduler.js";
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
let CYCLE_LENGTH = 0;
let MODE = "classic";         // "classic" | "americano"
let POINTS_PER_ROUND = 32;    // only used in americano mode

/* ===== DOM helpers ===== */
const el = id => document.getElementById(id);

/* ===== Round complete check ===== */
function isRoundComplete(roundIdx) {
  const courts = ROUNDS[roundIdx]?.courts || [];
  if (!courts.length) return false;
  return courts.every((_, ci) => {
    const w = WINNERS[`${roundIdx}:${ci}`];
    if (!w) return false;
    if (MODE === "americano") return typeof w === "object" && (w.a + w.b) === POINTS_PER_ROUND;
    return w === "A" || w === "B";
  });
}

/* ===== Rendering ===== */
function renderRoundNav() {
  el("roundTitle").textContent = `Runde ${CURRENT_ROUND + 1} av ${ROUNDS.length}`;
  el("prevRoundBtn").disabled = CURRENT_ROUND <= 0 || STATUS === "completed";
  el("nextRoundBtn").disabled = CURRENT_ROUND >= ROUNDS.length - 1 || STATUS === "completed";

  const onLastRound = CURRENT_ROUND === ROUNDS.length - 1;
  el("extraRoundBtn").style.display = onLastRound && STATUS === "active" ? "block" : "none";
}

function renderCurrentRound() {
  const container = el("courtsContainer");
  container.innerHTML = "";

  const courts = (ROUNDS[CURRENT_ROUND] || {}).courts || [];
  const activePlayers = new Set();

  courts.forEach((match, courtIdx) => {
    activePlayers.add(match.a[0]); activePlayers.add(match.a[1]);
    activePlayers.add(match.b[0]); activePlayers.add(match.b[1]);

    const winnerKey = `${CURRENT_ROUND}:${courtIdx}`;
    const card = document.createElement("div");
    card.className = "court-card";

    if (MODE === "americano") {
      // ===== Americano: velg vinner → trykk poeng =====
      const saved = WINNERS[winnerKey]; // {a, b} or undefined

      let initWinner = null;
      let initPts    = null;
      if (saved && typeof saved === "object") {
        initWinner = saved.a >= saved.b ? "A" : "B";
        initPts    = initWinner === "A" ? saved.a : saved.b;
      }

      const nameA   = `${match.a[0]} & ${match.a[1]}`;
      const nameB   = `${match.b[0]} & ${match.b[1]}`;
      const nameW   = `am_w_${CURRENT_ROUND}_${courtIdx}`;
      const idA     = `am_wA_${CURRENT_ROUND}_${courtIdx}`;
      const idB     = `am_wB_${CURRENT_ROUND}_${courtIdx}`;
      const idRow   = `am_score_${CURRENT_ROUND}_${courtIdx}`;
      const disabled = STATUS === "completed" ? "disabled" : "";

      card.innerHTML = `
        <div class="court-label">Bane ${courtIdx + 1}</div>
        <div class="teams">
          <span class="team">${match.a[0]} &amp; ${match.a[1]}</span>
          <span class="vs">vs</span>
          <span class="team">${match.b[0]} &amp; ${match.b[1]}</span>
        </div>
        <div class="winseg" role="group" aria-label="Vinner bane ${courtIdx + 1}">
          <input class="winradio" type="radio" name="${nameW}" id="${idA}" value="A"
            ${initWinner === "A" ? "checked" : ""} ${disabled}>
          <label class="winbtn" for="${idA}">A</label>
          <input class="winradio" type="radio" name="${nameW}" id="${idB}" value="B"
            ${initWinner === "B" ? "checked" : ""} ${disabled}>
          <label class="winbtn" for="${idB}">B</label>
        </div>
        <div id="${idRow}" class="americano-score-entry"${initWinner ? "" : ' style="display:none;"'}>
          <div class="americano-winner-label" id="${idRow}_wlabel"></div>
          <div class="score-picker-grid" id="${idRow}_grid"></div>
          <div class="americano-loser-text muted" id="${idRow}_llabel"></div>
        </div>
      `;

      // Labels via textContent (safe for special chars in player names)
      const wLabelEl = card.querySelector(`#${idRow}_wlabel`);
      const lLabelEl = card.querySelector(`#${idRow}_llabel`);
      if (initWinner) {
        wLabelEl.textContent = `${initWinner === "A" ? nameA : nameB} vant`;
        lLabelEl.textContent = `${initWinner === "A" ? nameB : nameA} får ${POINTS_PER_ROUND - initPts} poeng`;
      }

      // Build tap-able score buttons: from tied score (ceil(max/2)) up to max
      const gridEl    = card.querySelector(`#${idRow}_grid`);
      const half      = Math.ceil(POINTS_PER_ROUND / 2);
      const scoreBtns = [];
      for (let pts = half; pts <= POINTS_PER_ROUND; pts++) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "score-btn" + (pts === initPts ? " selected" : "");
        btn.textContent = pts;
        if (disabled) btn.disabled = true;
        gridEl.appendChild(btn);
        scoreBtns.push({ btn, pts });
      }

      if (STATUS !== "completed") {
        const radioA   = card.querySelector(`#${idA}`);
        const radioB   = card.querySelector(`#${idB}`);
        const scoreRow = card.querySelector(`#${idRow}`);
        const ri = CURRENT_ROUND, ci = courtIdx;

        const getWinner = () => radioA.checked ? "A" : (radioB.checked ? "B" : null);

        const selectScore = async (pts) => {
          scoreBtns.forEach(({ btn }) => btn.classList.remove("selected"));
          scoreBtns.find(x => x.pts === pts)?.btn.classList.add("selected");
          const w = getWinner();
          if (!w) return;
          lLabelEl.textContent = `${w === "A" ? nameB : nameA} får ${POINTS_PER_ROUND - pts} poeng`;
          const loserPts = POINTS_PER_ROUND - pts;
          const aScore = w === "A" ? pts : loserPts;
          const bScore = w === "A" ? loserPts : pts;
          try { await setAmericanoScore(ri, ci, aScore, bScore); }
          catch (err) { console.error(err); }
        };

        scoreBtns.forEach(({ btn, pts }) =>
          btn.addEventListener("click", () => selectScore(pts))
        );

        const onWinnerChange = () => {
          const w = getWinner();
          if (!w) { scoreRow.style.display = "none"; return; }
          wLabelEl.textContent = `${w === "A" ? nameA : nameB} vant`;
          lLabelEl.textContent = "";
          scoreBtns.forEach(({ btn }) => btn.classList.remove("selected"));
          scoreRow.style.display = "block";
        };

        radioA.addEventListener("change", onWinnerChange);
        radioB.addEventListener("change", onWinnerChange);
      }

    } else {
      // ===== Classic: win/loss radio buttons =====
      const currentWinner = WINNERS[winnerKey] || null;
      const idA = `w_${CURRENT_ROUND}_${courtIdx}_A`;
      const idB = `w_${CURRENT_ROUND}_${courtIdx}_B`;
      const name = `w_${CURRENT_ROUND}_${courtIdx}`;

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
    }

    container.appendChild(card);
  });

  const resting = PLAYERS.filter(p => !activePlayers.has(p));
  el("restingLine").textContent = resting.length ? `Hviler: ${resting.join(", ")}` : "";
}

function renderScores() {
  const entries = Object.entries(SCORES).sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
  const label = MODE === "americano" ? "poeng" : "seire";
  el("scores").innerHTML = entries
    .map(([p, pts]) => `<div class="score-row"><span class="pill">${pts}</span>${p}</div>`)
    .join("");
  // Update heading
  const h2 = el("scoresHeading");
  if (h2) h2.textContent = MODE === "americano" ? "Poeng" : "Poeng";
}

function hydrate(data) {
  PLAYERS = data.players || [];
  ROUNDS = data.rounds || [];
  CURRENT_ROUND = data.currentRound ?? 0;
  WINNERS = data.winners || {};
  SCORES = data.scores || {};
  STATUS = data.status || "active";
  CYCLE_LENGTH = data.cycleLength || 0;
  MODE = data.mode || "classic";
  POINTS_PER_ROUND = data.pointsPerRound || 32;

  el("loadingMsg").style.display = "none";
  el("mainContent").style.display = "block";

  // Show mode badge
  const badge = el("modeBadge");
  if (badge) {
    badge.textContent = MODE === "americano" ? `Americano · ${POINTS_PER_ROUND}p` : "Klassisk";
    badge.style.display = "inline-block";
  }

  if (STATUS === "completed") {
    const statsUrl = MODE === "americano" ? "./americano-stats.html" : "./stats.html";
    el("completedBanner").innerHTML =
      `Kampen er avsluttet. <a href="${statsUrl}">Se statistikk →</a>`;
    el("completedBanner").style.display = "block";
    el("endSessionBtn").style.display = "none";
    el("extraRoundBtn").style.display = "none";
  }

  renderRoundNav();
  renderCurrentRound();
  renderScores();
}

/* ===== Classic: set winner ===== */
async function setWinner(roundIdx, courtIdx, newWinner) {
  if (!CURRENT_DOC_ID) return;

  await runTransaction(db, async (tx) => {
    const ref = sessionRef(CURRENT_DOC_ID);
    const snap = await tx.get(ref);
    if (!snap.exists()) return;

    const data = snap.data();
    const match = ((data.rounds || [])[roundIdx]?.courts || [])[courtIdx];
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

/* ===== Americano: set scores ===== */
async function setAmericanoScore(roundIdx, courtIdx, aScore, bScore) {
  if (!CURRENT_DOC_ID) return;

  await runTransaction(db, async (tx) => {
    const ref = sessionRef(CURRENT_DOC_ID);
    const snap = await tx.get(ref);
    if (!snap.exists()) return;

    const data = snap.data();
    const match = ((data.rounds || [])[roundIdx]?.courts || [])[courtIdx];
    if (!match) return;

    const winners = { ...(data.winners || {}) };
    const scores = { ...(data.scores || {}) };
    const key = `${roundIdx}:${courtIdx}`;
    const prev = winners[key]; // {a, b} or undefined

    // Undo previous
    if (prev && typeof prev === "object") {
      for (const p of match.a) scores[p] = (scores[p] || 0) - prev.a;
      for (const p of match.b) scores[p] = (scores[p] || 0) - prev.b;
    }

    // Apply new
    for (const p of match.a) scores[p] = (scores[p] || 0) + aScore;
    for (const p of match.b) scores[p] = (scores[p] || 0) + bScore;

    winners[key] = { a: aScore, b: bScore };
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

/* ===== Extra rounds ===== */
async function addExtraRound() {
  if (!CURRENT_DOC_ID) return;
  const courtsPerRound = ROUNDS[0]?.courts?.length || 1;
  const extraRounds = buildExtraRounds(PLAYERS, courtsPerRound, Date.now() >>> 0);
  if (!extraRounds.length) return;

  const newRounds = [...ROUNDS, ...extraRounds];
  await updateDoc(sessionRef(CURRENT_DOC_ID), {
    rounds: newRounds,
    currentRound: ROUNDS.length,
    updatedAt: serverTimestamp(),
  });
}

/* ===== End session (cycle-aware, mode-aware) ===== */
async function endSession() {
  if (!CURRENT_DOC_ID) return;

  // Count consecutive complete rounds
  let completedRoundCount = 0;
  for (let i = 0; i < ROUNDS.length; i++) {
    if (isRoundComplete(i)) completedRoundCount++;
    else break;
  }

  const cycleLen = CYCLE_LENGTH || ROUNDS.length;
  const completedCycles = Math.floor(completedRoundCount / cycleLen);
  const validRounds = completedCycles * cycleLen;

  const cycleWord = completedCycles === 1 ? "hel runde" : "hele runder";
  let msg = `Avslutte kampen?\n\n${completedRoundCount} av ${ROUNDS.length} runder fullført · ${completedCycles} ${cycleWord} à ${cycleLen} runder.`;
  if (validRounds === 0) {
    msg += "\n\nIngen fullstendige runder – ingen statistikk vil bli lagret.";
  } else {
    msg += `\nStatistikk telles fra runde 1–${validRounds}.`;
  }

  if (!confirm(msg)) return;

  // Filter winners to valid rounds only
  const validWinners = {};
  for (const [key, val] of Object.entries(WINNERS)) {
    if (parseInt(key.split(":")[0], 10) < validRounds) validWinners[key] = val;
  }

  // Recompute scores from valid rounds
  const finalScores = {};
  const totalMatches = {};
  for (const p of PLAYERS) { finalScores[p] = 0; totalMatches[p] = 0; }

  for (let i = 0; i < validRounds; i++) {
    for (let ci = 0; ci < (ROUNDS[i]?.courts || []).length; ci++) {
      const match = ROUNDS[i].courts[ci];
      for (const p of [...match.a, ...match.b]) totalMatches[p] = (totalMatches[p] || 0) + 1;

      const w = validWinners[`${i}:${ci}`];
      if (MODE === "americano" && w && typeof w === "object") {
        for (const p of match.a) finalScores[p] = (finalScores[p] || 0) + w.a;
        for (const p of match.b) finalScores[p] = (finalScores[p] || 0) + w.b;
      } else if (MODE === "classic") {
        if (w === "A") { finalScores[match.a[0]]++; finalScores[match.a[1]]++; }
        if (w === "B") { finalScores[match.b[0]]++; finalScores[match.b[1]]++; }
      }
    }
  }

  try {
    if (validRounds > 0) {
      await addDoc(historyCol(), {
        pin: CURRENT_PIN,
        players: PLAYERS,
        numCourts: ROUNDS[0]?.courts?.length || 1,
        rounds: ROUNDS.slice(0, validRounds),
        winners: validWinners,
        finalScores,
        totalMatches,
        mode: MODE,
        pointsPerRound: POINTS_PER_ROUND,
        completedAt: serverTimestamp(),
      });
    }

    await updateDoc(sessionRef(CURRENT_DOC_ID), {
      status: "completed",
      updatedAt: serverTimestamp(),
    });

    window.location.href = MODE === "americano" ? "./americano-stats.html" : "./stats.html";
  } catch (err) {
    console.error(err);
    alert("Noe gikk galt ved avslutning: " + (err?.message || err));
  }
}

function leave() {
  if (unsubscribe) unsubscribe();
  window.location.href = "./index.html";
}

/* ===== Init ===== */
async function init() {
  try {
    await firebaseReady;
  } catch (err) {
    el("loadingMsg").textContent = "Klarte ikke å koble til Firebase: " + (err?.message || err);
    return;
  }

  const hash = window.location.hash;
  const m = hash.match(/[#&]pin=(\d+)/);
  if (!m) {
    el("loadingMsg").textContent = "Ingen PIN funnet. Gå tilbake og prøv igjen.";
    return;
  }

  CURRENT_PIN = m[1];
  el("pinDisplay").textContent = `PIN: ${CURRENT_PIN}`;
  CURRENT_DOC_ID = await getDocIdFromPin(CURRENT_PIN);

  unsubscribe = onSnapshot(
    sessionRef(CURRENT_DOC_ID),
    (snap) => {
      if (!snap.exists()) {
        el("loadingMsg").textContent = "Fant ingen sesjon med denne PIN-en.";
        el("loadingMsg").style.display = "block";
        el("mainContent").style.display = "none";
        return;
      }
      hydrate(snap.data());
    },
    (err) => {
      console.error(err);
      el("loadingMsg").textContent = "Tilgangsfeil: " + (err?.message || err);
      el("loadingMsg").style.display = "block";
    }
  );
}

/* ===== Event wiring ===== */
window.addEventListener("load", () => {
  // Classic winner radio buttons (delegated)
  document.addEventListener("change", async (e) => {
    const input = e.target;
    if (!input?.name?.startsWith("w_")) return;
    const parts = input.name.split("_");
    const roundIdx = parseInt(parts[1], 10);
    const courtIdx = parseInt(parts[2], 10);
    if (!Number.isFinite(roundIdx) || !Number.isFinite(courtIdx)) return;
    if (input.value !== "A" && input.value !== "B") return;
    try { await setWinner(roundIdx, courtIdx, input.value); }
    catch (err) { console.error("setWinner feil:", err); }
  });

  el("prevRoundBtn").addEventListener("click", async () => {
    if (CURRENT_ROUND > 0) {
      try { await goToRound(CURRENT_ROUND - 1); }
      catch (err) { console.error(err); }
    }
  });
  el("nextRoundBtn").addEventListener("click", async () => {
    if (CURRENT_ROUND < ROUNDS.length - 1) {
      try { await goToRound(CURRENT_ROUND + 1); }
      catch (err) { console.error(err); }
    }
  });

  el("extraRoundBtn").addEventListener("click", async () => {
    el("extraRoundBtn").disabled = true;
    try { await addExtraRound(); }
    catch (err) { console.error(err); alert("Klarte ikke å legge til runde: " + (err?.message || err)); }
    finally { el("extraRoundBtn").disabled = false; }
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
