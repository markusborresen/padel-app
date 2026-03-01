document.body.insertAdjacentHTML(
  "afterbegin",
  "<div style='padding:8px;border:2px solid red;margin:8px 0;'>APP.JS LOADED</div>"
);
// app.js (ES module) – fungerer direkte på GitHub Pages med <script type="module">

/* =========================
   Firebase (CDN ES Modules)
   ========================= */
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  setDoc,
  onSnapshot,
  runTransaction,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";

/* ---- Din firebaseConfig (fra Firebase Console) ---- */
const firebaseConfig = {
  apiKey: "AIzaSyC9fFogpchL6vJbia2s5hh60v8Xie5-kfA",
  authDomain: "padel-plan-3668b.firebaseapp.com",
  projectId: "padel-plan-3668b",
  storageBucket: "padel-plan-3668b.firebasestorage.app",
  messagingSenderId: "553858373608",
  appId: "1:553858373608:web:a98772c1412ee0b576365d",
  measurementId: "G-WS6EL0FWGN"
};

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);

await signInAnonymously(auth);

/* =========================
   Helpers: session id via planId + pin
   ========================= */
const COLLECTION = "sessions";

async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function getSessionId(planId, pin) {
  // PIN beskytter ved at doc-id blir uforutsigbar uten pin
  const hex = await sha256Hex(`${planId}|${pin}`);
  return hex.slice(0, 24);
}

function sessionRef(sessionId) {
  return doc(db, COLLECTION, sessionId);
}

/* =========================
   Scheduler logic (uendret)
   ========================= */
function gcd(a, b) { while (b) [a, b] = [b, a % b]; return Math.abs(a); }
function pairKey(x, y) { return x < y ? `${x}||${y}` : `${y}||${x}`; }

function mulberry32(seed) {
  let t = seed >>> 0;
  return function() {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
function randInt(rng, n) { return Math.floor(rng() * n); }

function perfectPossible(n) { return (n * (n - 1)) % 4 === 0; }

function chooseMatchCount(n) {
  if (perfectPossible(n)) return { M: (n * (n - 1)) / 4, perfectMode: true };
  const minForTeammates = Math.ceil(((n * (n - 1)) / 2) / 2);
  const base = n / gcd(n, 4);
  let M = Math.max(base, minForTeammates);
  if (M % base !== 0) M += (base - (M % base));
  return { M, perfectMode: false };
}

function combinations4(arr) {
  const out = [];
  for (let i = 0; i < arr.length; i++)
    for (let j = i + 1; j < arr.length; j++)
      for (let k = j + 1; k < arr.length; k++)
        for (let l = k + 1; l < arr.length; l++)
          out.push([arr[i], arr[j], arr[k], arr[l]]);
  return out;
}

function normalizeTeam(a, b) { return a < b ? [a, b] : [b, a]; }

function matchKey(m) {
  const ta = m.a.join("|");
  const tb = m.b.join("|");
  return ta < tb ? `${ta}__${tb}` : `${tb}__${ta}`;
}

function partitionsOfFour(p4) {
  const [p0, p1, p2, p3] = p4;
  const pairs = [
    [[p0, p1], [p2, p3]],
    [[p0, p2], [p1, p3]],
    [[p0, p3], [p1, p2]],
  ];
  const matches = [];
  for (const [t1, t2] of pairs) {
    const a = normalizeTeam(t1[0], t1[1]);
    const b = normalizeTeam(t2[0], t2[1]);
    const ta = a.join("|");
    const tb = b.join("|");
    const m = ta < tb ? { a, b } : { a: b, b: a };
    matches.push(m);
  }
  const seen = new Set();
  return matches.filter(m => (seen.has(matchKey(m)) ? false : seen.add(matchKey(m))));
}

function generateCandidateMatches(players) {
  const uniq = new Map();
  for (const p4 of combinations4(players)) {
    for (const m of partitionsOfFour(p4)) uniq.set(matchKey(m), m);
  }
  return Array.from(uniq.values());
}

const W = {
  PLAY_BALANCE: 10.0,
  TEAMMATE_MISSING: 25.0,
  TEAMMATE_REPEAT: 6.0,
  OPP_REPEAT: 2.0,
  CONSEC_REST: 1.2,
  PERFECT_DEVIATION: 40.0,
};

function scoreSchedule(schedule, players, perfectMode) {
  const n = players.length;
  const plays = new Map(players.map(p => [p, 0]));
  const teammateCounts = new Map();
  const oppCounts = new Map();

  const restStreak = new Map(players.map(p => [p, 0]));
  let restStreakPen = 0;

  for (const m of schedule) {
    const inMatch = new Set([m.a[0], m.a[1], m.b[0], m.b[1]]);

    for (const p of players) {
      if (inMatch.has(p)) {
        plays.set(p, plays.get(p) + 1);
        restStreak.set(p, 0);
      } else {
        const s = restStreak.get(p) + 1;
        restStreak.set(p, s);
        if (s >= 2) restStreakPen += (s - 1);
      }
    }

    const tk1 = pairKey(m.a[0], m.a[1]);
    const tk2 = pairKey(m.b[0], m.b[1]);
    teammateCounts.set(tk1, (teammateCounts.get(tk1) || 0) + 1);
    teammateCounts.set(tk2, (teammateCounts.get(tk2) || 0) + 1);

    for (const x of m.a) for (const y of m.b) {
      const ok = pairKey(x, y);
      oppCounts.set(ok, (oppCounts.get(ok) || 0) + 1);
    }
  }

  const vals = players.map(p => plays.get(p));
  const mean = vals.reduce((a, b) => a + b, 0) / n;
  const varPlay = vals.reduce((acc, v) => acc + (v - mean) ** 2, 0) / n;

  let missing = 0, deviation = 0, repeats = 0;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const pk = pairKey(players[i], players[j]);
    const c = teammateCounts.get(pk) || 0;
    if (c === 0) missing += 1;
    repeats += Math.max(0, c - 1);
    if (perfectMode) deviation += Math.abs(c - 1);
  }

  let oppRepeats = 0;
  for (const c of oppCounts.values()) oppRepeats += Math.max(0, c - 1);

  let total =
    W.PLAY_BALANCE * varPlay +
    W.TEAMMATE_MISSING * (missing ** 2) +
    W.TEAMMATE_REPEAT * repeats +
    W.OPP_REPEAT * oppRepeats +
    W.CONSEC_REST * restStreakPen;

  if (perfectMode) total += W.PERFECT_DEVIATION * deviation;
  return total;
}

function randomSchedule(candidates, M, rng) {
  const sched = [];
  for (let i = 0; i < M; i++) sched.push(candidates[randInt(rng, candidates.length)]);
  return sched;
}

function improveSchedule(init, candidates, players, perfectMode, rng, deadlineMs) {
  let best = init.slice();
  let bestScore = scoreSchedule(best, players, perfectMode);
  const LOCAL_STEPS = 1400;

  for (let step = 0; step < LOCAL_STEPS; step++) {
    if (performance.now() > deadlineMs) break;
    const next = best.slice();
    const i = randInt(rng, next.length);
    next[i] = candidates[randInt(rng, candidates.length)];
    const s = scoreSchedule(next, players, perfectMode);
    if (s < bestScore) {
      best = next;
      bestScore = s;
    }
  }
  return { best, bestScore };
}

function buildSchedule(players, seed) {
  const { M, perfectMode } = chooseMatchCount(players.length);
  const rng = mulberry32(seed);

  const candidates = generateCandidateMatches(players);

  let best = null;
  let bestScore = Infinity;

  const MAX_MS = 700;
  const deadline = performance.now() + MAX_MS;
  const RESTARTS = 120;

  for (let r = 0; r < RESTARTS; r++) {
    if (performance.now() > deadline) break;
    const init = randomSchedule(candidates, M, rng);
    const out = improveSchedule(init, candidates, players, perfectMode, rng, deadline);
    if (out.bestScore < bestScore) {
      best = out.best;
      bestScore = out.bestScore;
    }
  }

  return { schedule: best, M, perfectMode, seed };
}

/* =========================
   App state (kommer fra Firestore)
   ========================= */
const el = (id) => document.getElementById(id);
function setStatus(msg) { el("status").textContent = msg; }

let PLAN_ID = "";
let PIN = "";
let SESSION_ID = null;
let unsubscribe = null;

let PLAYERS = [];
let MATCHES = [];
let WINNERS = {}; // map: {"1":"A", ...}
let SCORES = {};
let PERFECT_MODE = false;

function initEmptyScores(players) {
  const o = {};
  for (const p of players) o[p] = 0;
  return o;
}

function parsePlayers(text) {
  const raw = text
    .split(/\r?\n|,/g)
    .map(s => s.trim())
    .filter(Boolean);

  const seen = new Set();
  const out = [];
  for (const name of raw) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/* =========================
   Rendering
   ========================= */
function renderSchedule() {
  const wrap = el("scheduleWrap");
  const body = el("scheduleBody");
  body.innerHTML = "";

  if (!MATCHES.length) {
    wrap.style.display = "none";
    return;
  }
  wrap.style.display = "block";

  MATCHES.forEach((m, idx) => {
    const i = idx + 1;
    const ida = `w${i}A`;
    const idb = `w${i}B`;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="c-kamp">${i}</td>
      <td class="c-lag"><b>${m.a[0]}</b> &amp; <b>${m.a[1]}</b></td>
      <td class="c-lag"><b>${m.b[0]}</b> &amp; <b>${m.b[1]}</b></td>
      <td class="c-win winnercell">
        <div class="winseg" role="group" aria-label="Vinner kamp ${i}">
          <input class="winradio" type="radio" name="w${i}" id="${ida}" value="A">
          <label class="winbtn" for="${ida}">A</label>
          <input class="winradio" type="radio" name="w${i}" id="${idb}" value="B">
          <label class="winbtn" for="${idb}">B</label>
        </div>
      </td>
    `;
    body.appendChild(tr);
  });

  // Sett radio fra WINNERS (Firestore)
  for (let i = 1; i <= MATCHES.length; i++) {
    const v = WINNERS[String(i)];
    if (v !== "A" && v !== "B") continue;
    const inp = document.querySelector(`input[name="w${i}"][value="${v}"]`);
    if (inp) inp.checked = true;
  }

  renderScores();

  const mode = PERFECT_MODE ? "PERFEKT" : "BEST MULIG";
  setStatus(`Plan ${PLAN_ID} • ${PLAYERS.length} spillere • ${MATCHES.length} kamper • ${mode}`);
}

function renderScores() {
  const s = el("scores");
  const entries = Object.entries(SCORES).sort((a,b) => (b[1]-a[1]) || a[0].localeCompare(b[0]));
  s.innerHTML = entries.map(([p, pts]) => `<div><span class="pill">${pts}</span>${p}</div>`).join("");
}

function hydrateFromFirestore(data) {
  PLAYERS = data.players || [];
  MATCHES = data.matches || [];
  WINNERS = data.winners || {};
  SCORES  = data.scores  || {};
  PERFECT_MODE = !!data.perfectMode;

  // Synk tekstfelt (praktisk)
  if (PLAYERS.length) el("playersInput").value = PLAYERS.join("\n");

  renderSchedule();
}

/* =========================
   Firestore operations
   ========================= */
async function joinSession(planId, pin) {
  PLAN_ID = planId.trim();
  PIN = pin.trim();

  if (!PLAN_ID) { setStatus("Skriv inn Plan ID."); return; }
  if (!PIN) { setStatus("Skriv inn PIN."); return; }

  const sid = await getSessionId(PLAN_ID, PIN);
  SESSION_ID = sid;

  // stopp gammel listener
  if (unsubscribe) unsubscribe();

  setStatus(`Joiner rom… (${PLAN_ID})`);

  unsubscribe = onSnapshot(sessionRef(sid), (snap) => {
    if (!snap.exists()) {
      // session ikke opprettet ennå
      PLAYERS = [];
      MATCHES = [];
      WINNERS = {};
      SCORES = {};
      PERFECT_MODE = false;
      renderSchedule();
      setStatus(`Rom finnes ikke ennå. Lim inn spillere og trykk "Generer oppsett". (Plan ${PLAN_ID})`);
      return;
    }
    hydrateFromFirestore(snap.data());
  }, (err) => {
    console.error(err);
    setStatus(`Feil ved live-tilkobling: ${err?.message || err}`);
  });
}

async function createOrReplaceSession(keepScore) {
  if (!PLAN_ID || !PIN) { setStatus("Trykk Join først (Plan ID + PIN)."); return; }

  const players = parsePlayers(el("playersInput").value);
  if (players.length < 4 || players.length > 8) {
    setStatus("Du må ha mellom 4 og 8 unike spillere.");
    return;
  }

  // Lag oppsett lokalt
  const seed = (Date.now() >>> 0);
  const res = buildSchedule(players, seed);
  const matches = res.schedule;
  const perfectMode = res.perfectMode;

  const sid = SESSION_ID || await getSessionId(PLAN_ID, PIN);
  SESSION_ID = sid;
  const ref = sessionRef(sid);

  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);

    let existingScores = {};
    if (keepScore && snap.exists()) {
      existingScores = snap.data().scores || {};
    }

    const scores = {};
    for (const p of players) scores[p] = Number(existingScores[p] || 0);

    tx.set(ref, {
      planId: PLAN_ID,
      players,
      matches,
      winners: {},          // ny runde
      scores,
      perfectMode,
      updatedAt: serverTimestamp()
    }, { merge: true });
  });

  // UI oppdateres av onSnapshot
}

async function setWinner(matchIndex, newWinner) {
  if (!SESSION_ID) { setStatus("Join først (Plan ID + PIN)."); return; }

  await runTransaction(db, async (tx) => {
    const ref = sessionRef(SESSION_ID);
    const snap = await tx.get(ref);
    if (!snap.exists()) return;

    const data = snap.data();
    const matches = data.matches || [];
    const winners = { ...(data.winners || {}) };
    const scores  = { ...(data.scores  || {}) };

    const m = matches[matchIndex - 1];
    if (!m) return;

    const prevWinner = winners[String(matchIndex)] || null;

    const addTeam = (team, delta) => {
      scores[team[0]] = (scores[team[0]] || 0) + delta;
      scores[team[1]] = (scores[team[1]] || 0) + delta;
    };

    if (prevWinner === "A") addTeam(m.a, -1);
    if (prevWinner === "B") addTeam(m.b, -1);

    if (newWinner === "A") addTeam(m.a, +1);
    if (newWinner === "B") addTeam(m.b, +1);

    winners[String(matchIndex)] = newWinner;

    tx.update(ref, { winners, scores, updatedAt: serverTimestamp() });
  });

  // UI oppdateres av onSnapshot
}

async function resetRound() {
  if (!SESSION_ID) { setStatus("Join først (Plan ID + PIN)."); return; }
  await setDoc(sessionRef(SESSION_ID), { winners: {}, updatedAt: serverTimestamp() }, { merge: true });
}

async function resetAll() {
  if (!SESSION_ID) { setStatus("Join først (Plan ID + PIN)."); return; }

  await runTransaction(db, async (tx) => {
    const ref = sessionRef(SESSION_ID);
    const snap = await tx.get(ref);
    if (!snap.exists()) return;

    const data = snap.data();
    const players = data.players || [];
    const scores = initEmptyScores(players);

    tx.update(ref, { winners: {}, scores, updatedAt: serverTimestamp() });
  });
}

/* =========================
   Wiring (matches din index.html)
   ========================= */
function todayISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,"0");
  const dd = String(d.getDate()).padStart(2,"0");
  return `${yyyy}-${mm}-${dd}`;
}

document.addEventListener("change", async (e) => {
  const t = e.target;
  if (!t || !t.name || !t.name.startsWith("w")) return;

  const matchIndex = parseInt(t.name.slice(1), 10);
  if (!Number.isFinite(matchIndex)) return;

  const newWinner = t.value; // A/B
  if (newWinner !== "A" && newWinner !== "B") return;

  try {
    await setWinner(matchIndex, newWinner);
  } catch (err) {
    console.error(err);
    setStatus(`Kunne ikke oppdatere vinner: ${err?.message || err}`);
  }
});

window.addEventListener("load", () => {
  // Default planId = i dag
  el("planId").value = todayISO();

  // Join
  el("joinBtn").addEventListener("click", async () => {
    const pid = el("planId").value.trim() || todayISO();
    el("planId").value = pid;

    const pin = (el("pin")?.value || "").trim();
    await joinSession(pid, pin);
  });

  // Generer oppsett (skriver til Firestore)

  // DEBUG: skriv et synlig dokument med fast ID
  try {
    setStatus("DEBUG: prøver å skrive til Firestore…");
    await setDoc(sessionRef("debug_from_app"), { ping: Date.now(), from: "generateBtn" }, { merge: true });
    setStatus("✅ DEBUG: skrev debug_from_app i Firestore. Genererer oppsett…");
  } catch (err) {
    console.error(err);
    setStatus("❌ DEBUG write feilet: " + (err?.message || err));
    return; // stopp her – da vet vi at problemet er write/rules
  }
  
  el("generateBtn").addEventListener("click", async () => {
    const pid = el("planId").value.trim() || todayISO();
    el("planId").value = pid;

    const pin = (el("pin")?.value || "").trim();
    if (!pin) { setStatus("Skriv inn PIN før du genererer."); return; }

    // Sørg for at vi har en live listener (join) før vi skriver
    if (!SESSION_ID || PLAN_ID !== pid || PIN !== pin) {
      await joinSession(pid, pin);
    }

    const keep = el("keepScore").checked;
    try {
      await createOrReplaceSession(keep);
    } catch (err) {
      console.error(err);
      setStatus(`Kunne ikke generere oppsett: ${err?.message || err}`);
    }
  });

  // Ny runde (nullstill kampvalg)
  el("newRoundBtn").addEventListener("click", async () => {
    try {
      await resetRound();
      setStatus(`Ny runde startet (poeng beholdt) • Plan ${PLAN_ID}`);
    } catch (err) {
      console.error(err);
      setStatus(`Kunne ikke starte ny runde: ${err?.message || err}`);
    }
  });

  // Nullstill alt
  el("resetAllBtn").addEventListener("click", async () => {
    try {
      await resetAll();
      setStatus(`Nullstilt kampvalg og poeng • Plan ${PLAN_ID}`);
    } catch (err) {
      console.error(err);
      setStatus(`Kunne ikke nullstille alt: ${err?.message || err}`);
    }
  });

  setStatus("Skriv Plan ID + PIN og trykk Join. Deretter kan du generere oppsett.");
});




