import {
  db, firebaseReady, getDocIdFromPin, sessionRef, historyCol
} from "./firebase.js";
import { buildExtraRounds } from "./scheduler.js";
import {
  isRoundComplete, allRoundsComplete, buildFinaleRound, computeResult
} from "./results.js";
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
let POINTS_PER_ROUND = 32;

let RENDERED_ROUND = null; // last round drawn – entrance animation only runs when it changes

// Local picks not yet in Firestore, so a snapshot re-render doesn't wipe them.
// "round:court" -> { w: "A"|"B", pts: number|null, base: JSON of WINNERS[key] when picked }
let PENDING_WINNER = {};

/* ===== DOM helpers ===== */
const el = id => document.getElementById(id);

/* ===== Motion (same curves as --ease-out / --ease-in-out in style.css) ===== */
const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";
const EASE_IN_OUT = "cubic-bezier(0.77, 0, 0.175, 1)";
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// Fade in (and nudge from dx/dy unless reduced motion)
function enter(node, { dx = 0, dy = 0, duration = 220, delay = 0 } = {}) {
  const still = reducedMotion();
  const from = still || (!dx && !dy) ? "none" : `translate(${dx}px, ${dy}px)`;
  node.animate(
    [{ opacity: 0, transform: from }, { opacity: 1, transform: "none" }],
    { duration, delay: still ? 0 : delay, easing: EASE_OUT, fill: "backwards" }
  );
}

const roundDone = i => isRoundComplete(ROUNDS[i], i, WINNERS, POINTS_PER_ROUND);
const hasFinale = () => ROUNDS.some(r => r.final);

/* ===== Rendering ===== */
function renderRoundNav() {
  const round = ROUNDS[CURRENT_ROUND] || {};
  el("roundTitle").textContent = round.final
    ? "🏆 Finale"
    : `Runde ${CURRENT_ROUND + 1} av ${ROUNDS.filter(r => !r.final).length}`;
  el("prevRoundBtn").disabled = CURRENT_ROUND <= 0 || STATUS === "completed";
  el("nextRoundBtn").disabled = CURRENT_ROUND >= ROUNDS.length - 1 || STATUS === "completed";

  const active = STATUS === "active";
  el("extraRoundBtn").style.display = active && !hasFinale() ? "block" : "none";
  el("finaleBtn").style.display =
    active && !hasFinale() && allRoundsComplete(ROUNDS, WINNERS, POINTS_PER_ROUND)
      ? "block" : "none";
}

function renderCurrentRound() {
  // Snapshots re-render on every score; only animate when the round actually changes
  const dir = RENDERED_ROUND === null || RENDERED_ROUND === CURRENT_ROUND
    ? 0 : Math.sign(CURRENT_ROUND - RENDERED_ROUND);
  if (RENDERED_ROUND !== CURRENT_ROUND) PENDING_WINNER = {};
  RENDERED_ROUND = CURRENT_ROUND;

  const container = el("courtsContainer");
  container.innerHTML = "";

  const courts = (ROUNDS[CURRENT_ROUND] || {}).courts || [];
  const activePlayers = new Set();

  courts.forEach((match, courtIdx) => {
    [...match.a, ...match.b].forEach(p => activePlayers.add(p));

    const card = document.createElement("div");
    card.className = "court-card";

    const key   = `${CURRENT_ROUND}:${courtIdx}`;
    const saved = WINNERS[key]; // {a, b} or undefined
    const base  = JSON.stringify(saved ?? null);
    // A pending pick only survives while the saved value is unchanged (saved value wins)
    if (PENDING_WINNER[key]?.base !== base) delete PENDING_WINNER[key];
    const pending = PENDING_WINNER[key];

    let initWinner = null;
    let initPts    = null;
    if (pending) {
      initWinner = pending.w;
      initPts    = pending.pts;
    } else if (saved && typeof saved === "object") {
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
      if (initPts !== null) {
        lLabelEl.textContent = `${initWinner === "A" ? nameB : nameA} får ${POINTS_PER_ROUND - initPts} poeng`;
      }
    }

    // Tap-able score buttons: from tied score (ceil(max/2)) up to max
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
        const loserPts = POINTS_PER_ROUND - pts;
        lLabelEl.textContent = `${w === "A" ? nameB : nameA} får ${loserPts} poeng`;
        const aScore = w === "A" ? pts : loserPts;
        const bScore = w === "A" ? loserPts : pts;
        // Keep the pick across snapshots until our own write lands (it then changes base)
        PENDING_WINNER[key] = { w, pts, base };
        try { await setAmericanoScore(ri, ci, aScore, bScore); }
        catch (err) {
          console.error(err);
          if (PENDING_WINNER[key]) PENDING_WINNER[key].pts = null;
        }
      };

      scoreBtns.forEach(({ btn, pts }) =>
        btn.addEventListener("click", () => selectScore(pts))
      );

      const onWinnerChange = () => {
        const w = getWinner();
        if (!w) { scoreRow.style.display = "none"; return; }
        PENDING_WINNER[key] = { w, pts: null, base };
        wLabelEl.textContent = `${w === "A" ? nameA : nameB} vant`;
        lLabelEl.textContent = "";
        scoreBtns.forEach(({ btn }) => btn.classList.remove("selected"));
        const wasHidden = scoreRow.style.display === "none";
        scoreRow.style.display = "block";
        if (wasHidden) enter(scoreRow, { dy: -4, duration: 180 });
      };

      radioA.addEventListener("change", onWinnerChange);
      radioB.addEventListener("change", onWinnerChange);
    }

    container.appendChild(card);
    if (dir) enter(card, { dx: dir * 16, delay: courtIdx * 40 });
  });

  const resting = PLAYERS.filter(p => !activePlayers.has(p));
  el("restingLine").textContent = resting.length ? `Hviler: ${resting.join(", ")}` : "";
}

// Planned matches per player (finale excluded): uneven counts give an advantage
function plannedMatches() {
  const counts = Object.fromEntries(PLAYERS.map(p => [p, 0]));
  for (const r of ROUNDS) {
    if (r.final) continue;
    for (const m of r.courts || []) for (const p of [...m.a, ...m.b]) counts[p] = (counts[p] || 0) + 1;
  }
  return counts;
}

function renderScores() {
  const counts = plannedMatches();
  const vals = Object.values(counts);
  const min = Math.min(...vals), max = Math.max(...vals);
  const extra = max > min ? new Set(PLAYERS.filter(p => counts[p] > min)) : new Set();

  const note = el("advantageNote");
  if (extra.size) {
    const names = [...extra].join(", ");
    const diff = max - min;
    note.textContent = `⚠️ Fordel: ${names} spiller ${diff === 1 ? "én kamp" : diff + " kamper"} mer enn de andre `
      + `(${max} mot ${min}) og kan derfor få flere poeng.`;
    note.style.display = "block";
  } else {
    note.style.display = "none";
  }

  const entries = Object.entries(SCORES).sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
  const list = el("scores");

  // FLIP: remember each player's row position and points before re-rendering
  // (relative to the list, since the courts above may change height in the same render)
  const posOf = row => {
    const r = row.getBoundingClientRect(), l = list.getBoundingClientRect();
    return { x: r.left - l.left, y: r.top - l.top };
  };
  const before = new Map([...list.children].map(row =>
    [row.dataset.player, { ...posOf(row), pts: row.dataset.pts }]
  ));

  list.innerHTML = entries
    .map(([p, pts]) => {
      const tag = extra.has(p) ? ` <span class="extra-tag">+${counts[p] - min} kamp</span>` : "";
      return `<div class="score-row"><span class="pill">${pts}</span>${p}${tag}</div>`;
    })
    .join("");

  [...list.children].forEach((row, i) => {
    const [player, pts] = entries[i];
    row.dataset.player = player;
    row.dataset.pts = pts;

    const prev = before.get(player);
    if (!prev) return;
    const now = posOf(row);
    const dx = prev.x - now.x, dy = prev.y - now.y;
    if ((dx || dy) && !reducedMotion()) {
      row.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
        { duration: 300, easing: EASE_IN_OUT }
      );
    }
    if (prev.pts !== String(pts)) {
      row.querySelector(".pill").animate(
        [{ backgroundColor: "#dcfce7", borderColor: "#86efac" }, {}],
        { duration: 900, easing: "ease" }
      );
    }
  });
}

function hydrate(data) {
  if (data.mode && data.mode !== "americano") {
    el("loadingMsg").innerHTML =
      'Dette er en gammel klassisk kamp, som ikke støttes lenger. Avslutt den via <a href="./admin.html">Admin</a>.';
    el("loadingMsg").style.display = "block";
    el("mainContent").style.display = "none";
    return;
  }

  PLAYERS = data.players || [];
  ROUNDS = data.rounds || [];
  CURRENT_ROUND = data.currentRound ?? 0;
  WINNERS = data.winners || {};
  SCORES = data.scores || {};
  STATUS = data.status || "active";
  CYCLE_LENGTH = data.cycleLength || 0;
  POINTS_PER_ROUND = data.pointsPerRound || 32;

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

/* ===== Set scores ===== */
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

/* ===== Extra rounds (a full new set) ===== */
async function addExtraRound() {
  if (!CURRENT_DOC_ID) return;
  if (!allRoundsComplete(ROUNDS, WINNERS, POINTS_PER_ROUND) &&
      !confirm("Ikke alle kamper er ferdig registrert. Legge til ny runde likevel?")) return;

  const courtsPerRound = ROUNDS[0]?.courts?.length || 1;
  const lastPlaying = new Set((ROUNDS[ROUNDS.length - 1]?.courts || []).flatMap(m => [...m.a, ...m.b]));
  const lastRested = PLAYERS.filter(p => !lastPlaying.has(p));
  const extraRounds = buildExtraRounds(PLAYERS, courtsPerRound, Date.now() >>> 0, lastRested);
  if (!extraRounds.length) return;

  await updateDoc(sessionRef(CURRENT_DOC_ID), {
    rounds: [...ROUNDS, ...extraRounds],
    currentRound: ROUNDS.length,
    updatedAt: serverTimestamp(),
  });
}

/* ===== Finale ===== */
async function addFinale() {
  if (!CURRENT_DOC_ID || hasFinale()) return;
  const courtsPerRound = ROUNDS[0]?.courts?.length || 1;
  const finale = buildFinaleRound(PLAYERS, SCORES, courtsPerRound);
  if (!finale.courts.length) return;
  if (!confirm("Start finale? Etter finalen kan du ikke legge til flere runder.")) return;

  await updateDoc(sessionRef(CURRENT_DOC_ID), {
    rounds: [...ROUNDS, finale],
    currentRound: ROUNDS.length,
    updatedAt: serverTimestamp(),
  });
}

/* ===== End session ===== */
async function endSession() {
  if (!CURRENT_DOC_ID) return;

  const res = computeResult({
    rounds: ROUNDS, winners: WINNERS, players: PLAYERS,
    pointsPerRound: POINTS_PER_ROUND, cycleLength: CYCLE_LENGTH,
  });
  const normalCount = ROUNDS.filter(r => !r.final).length;

  const cycleWord = res.completedCycles === 1 ? "hel runde" : "hele runder";
  let msg = `Avslutte kampen?\n\n${res.completedNormal} av ${normalCount} runder fullført · ${res.completedCycles} ${cycleWord} à ${res.cycleLen} runder.`;
  if (hasFinale()) msg += res.finaleDone ? "\nFinalen telles med." : "\nFinalen er ikke ferdig og telles ikke.";
  if (!res.validRounds.length) msg += "\n\nIngen fullstendige runder – ingen statistikk vil bli lagret.";

  if (!confirm(msg)) return;

  try {
    if (res.validRounds.length) {
      await addDoc(historyCol(), {
        pin: CURRENT_PIN,
        players: PLAYERS,
        numCourts: ROUNDS[0]?.courts?.length || 1,
        rounds: res.validRounds,
        winners: res.validWinners,
        finalScores: res.finalScores,
        totalMatches: res.totalMatches,
        mode: "americano",
        pointsPerRound: POINTS_PER_ROUND,
        completedAt: serverTimestamp(),
      });
    }

    await updateDoc(sessionRef(CURRENT_DOC_ID), {
      status: "completed",
      updatedAt: serverTimestamp(),
    });

    window.location.href = "./americano-stats.html";
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

  const m = window.location.hash.match(/[#&]pin=(\d+)/);
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

/* ===== Event wiring (module scripts run after the DOM is parsed) ===== */
function wireButton(id, fn, errMsg) {
  el(id).addEventListener("click", async () => {
    el(id).disabled = true;
    try { await fn(); }
    catch (err) { console.error(err); alert(errMsg + (err?.message || err)); }
    finally { el(id).disabled = false; }
  });
}

el("prevRoundBtn").addEventListener("click", () => {
  if (CURRENT_ROUND > 0) goToRound(CURRENT_ROUND - 1).catch(console.error);
});
el("nextRoundBtn").addEventListener("click", () => {
  if (CURRENT_ROUND < ROUNDS.length - 1) goToRound(CURRENT_ROUND + 1).catch(console.error);
});

wireButton("extraRoundBtn", addExtraRound, "Klarte ikke å legge til runde: ");
wireButton("finaleBtn", addFinale, "Klarte ikke å lage finale: ");

el("copyPinBtn").addEventListener("click", async () => {
  if (!CURRENT_PIN) return;
  try { await navigator.clipboard.writeText(CURRENT_PIN); }
  catch { prompt("Kopier PIN:", CURRENT_PIN); }
});

el("endSessionBtn").addEventListener("click", endSession);
el("leaveBtn").addEventListener("click", leave);

init();
