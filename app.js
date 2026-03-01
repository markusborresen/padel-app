import { initializeApp } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-auth.js";
import {
  getFirestore, doc, setDoc, onSnapshot, runTransaction, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";

/* ---- firebaseConfig ---- */
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
const firebaseReady = signInAnonymously(auth);

const COLLECTION = "sessions";

/* ===== Session id: sha256(sessionId|pin) ===== */
async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function getDocId(sessionId, pin) {
  const hex = await sha256Hex(`${sessionId}|${pin}`);
  return hex.slice(0, 24);
}
function sessionRef(docId) {
  return doc(db, COLLECTION, docId);
}

/* ===== Scheduler (samme som før) ===== */
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
    matches.push(ta < tb ? { a, b } : { a: b, b: a });
  }
  const seen = new Set();
  return matches.filter(m => (seen.has(matchKey(m)) ? false : seen.add(matchKey(m))));
}
function generateCandidateMatches(players) {
  const uniq = new Map();
  for (const p4 of combinations4(players)) for (const m of partitionsOfFour(p4)) uniq.set(matchKey(m), m);
  return Array.from(uniq.values());
}
const W = { PLAY_BALANCE:10, TEAMMATE_MISSING:25, TEAMMATE_REPEAT:6, OPP_REPEAT:2, CONSEC_REST:1.2, PERFECT_DEVIATION:40 };
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
      if (inMatch.has(p)) { plays.set(p, plays.get(p)+1); restStreak.set(p,0); }
      else { const s = restStreak.get(p)+1; restStreak.set(p,s); if (s>=2) restStreakPen += (s-1); }
    }
    const tk1 = pairKey(m.a[0], m.a[1]);
    const tk2 = pairKey(m.b[0], m.b[1]);
    teammateCounts.set(tk1, (teammateCounts.get(tk1)||0)+1);
    teammateCounts.set(tk2, (teammateCounts.get(tk2)||0)+1);
    for (const x of m.a) for (const y of m.b) {
      const ok = pairKey(x,y);
      oppCounts.set(ok, (oppCounts.get(ok)||0)+1);
    }
  }

  const vals = players.map(p => plays.get(p));
  const mean = vals.reduce((a,b)=>a+b,0)/n;
  const varPlay = vals.reduce((acc,v)=>acc+(v-mean)**2,0)/n;

  let missing=0, deviation=0, repeats=0;
  for (let i=0;i<n;i++) for (let j=i+1;j<n;j++) {
    const pk = pairKey(players[i], players[j]);
    const c = teammateCounts.get(pk)||0;
    if (c===0) missing++;
    repeats += Math.max(0,c-1);
    if (perfectMode) deviation += Math.abs(c-1);
  }

  let oppRepeats=0;
  for (const c of oppCounts.values()) oppRepeats += Math.max(0,c-1);

  let total =
    W.PLAY_BALANCE*varPlay +
    W.TEAMMATE_MISSING*(missing**2) +
    W.TEAMMATE_REPEAT*repeats +
    W.OPP_REPEAT*oppRepeats +
    W.CONSEC_REST*restStreakPen;

  if (perfectMode) total += W.PERFECT_DEVIATION*deviation;
  return total;
}
function randomSchedule(candidates, M, rng) {
  const sched=[]; for (let i=0;i<M;i++) sched.push(candidates[randInt(rng,candidates.length)]); return sched;
}
function improveSchedule(init, candidates, players, perfectMode, rng, deadlineMs) {
  let best=init.slice();
  let bestScore=scoreSchedule(best, players, perfectMode);
  const LOCAL_STEPS=1400;
  for (let step=0;step<LOCAL_STEPS;step++) {
    if (performance.now()>deadlineMs) break;
    const next=best.slice();
    next[randInt(rng,next.length)] = candidates[randInt(rng,candidates.length)];
    const s=scoreSchedule(next, players, perfectMode);
    if (s<bestScore) { best=next; bestScore=s; }
  }
  return best;
}
function buildSchedule(players, seed) {
  const { M, perfectMode } = chooseMatchCount(players.length);
  const rng = mulberry32(seed);
  const candidates = generateCandidateMatches(players);
  let best=null, bestScore=Infinity;
  const deadline = performance.now() + 700;
  for (let r=0;r<120;r++) {
    if (performance.now()>deadline) break;
    const init = randomSchedule(candidates, M, rng);
    const improved = improveSchedule(init, candidates, players, perfectMode, rng, deadline);
    const s = scoreSchedule(improved, players, perfectMode);
    if (s<bestScore) { best=improved; bestScore=s; }
  }
  return { schedule: best, perfectMode };
}

/* ===== State ===== */
const el = (id) => document.getElementById(id);
function showView(name) {
  for (const id of ["viewHome","viewCreate","viewJoin","viewMatch"]) {
    el(id).classList.toggle("active", id === name);
  }
}

let CURRENT_SESSION_ID = "";
let CURRENT_PIN = "";
let CURRENT_DOC_ID = null;
let unsubscribe = null;

let PLAYERS = [];
let MATCHES = [];
let WINNERS = {};
let SCORES = {};

function initEmptyScores(players) {
  const o = {};
  for (const p of players) o[p] = 0;
  return o;
}
function parsePlayers(text) {
  const raw = text.split(/\r?\n|,/g).map(s=>s.trim()).filter(Boolean);
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

/* ===== Rendering ===== */
function renderMatchInfo() {
  el("matchInfo").textContent = CURRENT_SESSION_ID ? `Session: ${CURRENT_SESSION_ID}` : "";
}
function renderSchedule() {
  const body = el("scheduleBody");
  body.innerHTML = "";
  if (!MATCHES.length) return;

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

  for (let i = 1; i <= MATCHES.length; i++) {
    const v = WINNERS[String(i)];
    if (v !== "A" && v !== "B") continue;
    const inp = document.querySelector(`input[name="w${i}"][value="${v}"]`);
    if (inp) inp.checked = true;
  }
}
function renderScores() {
  const s = el("scores");
  const entries = Object.entries(SCORES).sort((a,b)=>(b[1]-a[1])||a[0].localeCompare(b[0]));
  s.innerHTML = entries.map(([p, pts]) => `<div><span class="pill">${pts}</span>${p}</div>`).join("");
}
function hydrate(data) {
  PLAYERS = data.players || [];
  MATCHES = data.matches || [];
  WINNERS = data.winners || {};
  SCORES  = data.scores  || {};
  renderMatchInfo();
  renderSchedule();
  renderScores();
}

/* ===== Firestore ops ===== */
async function join(sessionId, pin, { alertIfMissing = true } = {}) {
  await firebaseReady;
  CURRENT_SESSION_ID = sessionId.trim();
  CURRENT_PIN = pin.trim();
  if (!CURRENT_SESSION_ID || !CURRENT_PIN) return false;

  CURRENT_DOC_ID = await getDocId(CURRENT_SESSION_ID, CURRENT_PIN);

  if (unsubscribe) unsubscribe();
  unsubscribe = onSnapshot(sessionRef(CURRENT_DOC_ID), (snap) => {
    if (!snap.exists()) {
      if (alertIfMissing) alert("Fant ingen session. Be noen trykke Create først.");
      return;
    }
    hydrate(snap.data());
    showView("viewMatch");
  });

  return true;
}

async function createSession(sessionId, pin, playersText, keepScore) {
  await firebaseReady;

  const players = parsePlayers(playersText);
  if (players.length < 4 || players.length > 8) {
    alert("Du må ha mellom 4 og 8 unike spillere.");
    return;
  }

  await join(sessionId, pin, { alertIfMissing: false });

  const seed = (Date.now() >>> 0);
  const res = buildSchedule(players, seed);
  const matches = res.schedule;

  const ref = sessionRef(CURRENT_DOC_ID);

  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);

    let existingScores = {};
    if (keepScore && snap.exists()) existingScores = snap.data().scores || {};

    const scores = {};
    for (const p of players) scores[p] = Number(existingScores[p] || 0);

    tx.set(ref, {
      sessionId: CURRENT_SESSION_ID,
      players,
      matches,
      winners: {},
      scores,
      updatedAt: serverTimestamp()
    }, { merge: true });
  });
}

async function setWinner(matchIndex, newWinner) {
  await firebaseReady;
  if (!CURRENT_DOC_ID) return;

  await runTransaction(db, async (tx) => {
    const ref = sessionRef(CURRENT_DOC_ID);
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
}

async function resetRound() {
  await firebaseReady;
  if (!CURRENT_DOC_ID) return;
  await setDoc(sessionRef(CURRENT_DOC_ID), { winners: {}, updatedAt: serverTimestamp() }, { merge: true });
}

async function resetAll() {
  await firebaseReady;
  if (!CURRENT_DOC_ID) return;

  await runTransaction(db, async (tx) => {
    const ref = sessionRef(CURRENT_DOC_ID);
    const snap = await tx.get(ref);
    if (!snap.exists()) return;

    const data = snap.data();
    const players = data.players || [];
    const scores = initEmptyScores(players);

    tx.update(ref, { winners: {}, scores, updatedAt: serverTimestamp() });
  });
}

function leave() {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;

  CURRENT_SESSION_ID = "";
  CURRENT_PIN = "";
  CURRENT_DOC_ID = null;

  PLAYERS = [];
  MATCHES = [];
  WINNERS = {};
  SCORES = {};

  el("scheduleBody").innerHTML = "";
  el("scores").innerHTML = "";
  el("matchInfo").textContent = "";

  showView("viewHome");
}

/* ===== Wiring ===== */
document.addEventListener("change", async (e) => {
  const t = e.target;
  if (!t || !t.name || !t.name.startsWith("w")) return;

  const matchIndex = parseInt(t.name.slice(1), 10);
  if (!Number.isFinite(matchIndex)) return;

  const newWinner = t.value;
  if (newWinner !== "A" && newWinner !== "B") return;

  try { await setWinner(matchIndex, newWinner); } catch (err) { console.error(err); }
});

window.addEventListener("load", () => {
  // Home nav
  el("goCreateBtn").addEventListener("click", () => showView("viewCreate"));
  el("goJoinBtn").addEventListener("click", () => showView("viewJoin"));

  // Back
  el("createBackBtn").addEventListener("click", () => showView("viewHome"));
  el("joinBackBtn").addEventListener("click", () => showView("viewHome"));

  // Create
  el("createStartBtn").addEventListener("click", async () => {
    const sid = el("createSessionId").value.trim();
    const pin = el("createPin").value.trim();
    const keep = el("createKeepScore").checked;
    const playersText = el("createPlayers").value;

    if (!sid || !pin) { alert("Session ID og PIN må fylles ut."); return; }

    try {
      await createSession(sid, pin, playersText, keep);
      // match view åpnes av snapshot når doc finnes
    } catch (err) {
      console.error(err);
      alert(err?.message || err);
    }
  });

  // Join
  el("joinStartBtn").addEventListener("click", async () => {
    const sid = el("joinSessionId").value.trim();
    const pin = el("joinPin").value.trim();
    if (!sid || !pin) { alert("Session ID og PIN må fylles ut."); return; }

    try {
      await join(sid, pin, { alertIfMissing: true });
    } catch (err) {
      console.error(err);
      alert(err?.message || err);
    }
  });

  // Match actions
  el("leaveBtn").addEventListener("click", leave);
  el("newRoundBtn").addEventListener("click", async () => { try { await resetRound(); } catch (e) { console.error(e); } });
  el("resetAllBtn").addEventListener("click", async () => { try { await resetAll(); } catch (e) { console.error(e); } });
});
