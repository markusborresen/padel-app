// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyC9fFogpchL6vJbia2s5hh60v8Xie5-kfA",
  authDomain: "padel-plan-3668b.firebaseapp.com",
  projectId: "padel-plan-3668b",
  storageBucket: "padel-plan-3668b.firebasestorage.app",
  messagingSenderId: "553858373608",
  appId: "1:553858373608:web:a98772c1412ee0b576365d",
  measurementId: "G-WS6EL0FWGN"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);

/* ====== Utils ====== */
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

/* ====== Core: choose match count ====== */
function perfectPossible(n) { return (n * (n - 1)) % 4 === 0; }

function chooseMatchCount(n) {
  if (perfectPossible(n)) {
    return { M: (n * (n - 1)) / 4, perfectMode: true };
  }
  const minForTeammates = Math.ceil(((n * (n - 1)) / 2) / 2); // ceil(C(n,2)/2)
  const base = n / gcd(n, 4); // smallest M s.t. 4M % n == 0 => multiple of base
  let M = Math.max(base, minForTeammates);
  if (M % base !== 0) M += (base - (M % base));
  return { M, perfectMode: false };
}

/* ====== Candidate matches ====== */
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
  // m: {a:[p1,p2], b:[p3,p4]} with teams sorted internally + match teams sorted
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
  // dedupe within the 3 (paranoia)
  const seen = new Set();
  return matches.filter(m => (seen.has(matchKey(m)) ? false : seen.add(matchKey(m))));
}

function generateCandidateMatches(players) {
  const uniq = new Map();
  for (const p4 of combinations4(players)) {
    for (const m of partitionsOfFour(p4)) {
      uniq.set(matchKey(m), m);
    }
  }
  return Array.from(uniq.values());
}

/* ====== Scoring ====== */
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
  const teammateCounts = new Map(); // pairKey -> count
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

    // teammates
    const tk1 = pairKey(m.a[0], m.a[1]);
    const tk2 = pairKey(m.b[0], m.b[1]);
    teammateCounts.set(tk1, (teammateCounts.get(tk1) || 0) + 1);
    teammateCounts.set(tk2, (teammateCounts.get(tk2) || 0) + 1);

    // opponents (cross pairs)
    for (const x of m.a) for (const y of m.b) {
      const ok = pairKey(x, y);
      oppCounts.set(ok, (oppCounts.get(ok) || 0) + 1);
    }
  }

  // play variance
  const vals = players.map(p => plays.get(p));
  const mean = vals.reduce((a, b) => a + b, 0) / n;
  const varPlay = vals.reduce((acc, v) => acc + (v - mean) ** 2, 0) / n;

  // teammate coverage/repeats
  let missing = 0, deviation = 0, repeats = 0;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const pk = pairKey(players[i], players[j]);
    const c = teammateCounts.get(pk) || 0;
    if (c === 0) missing += 1;
    repeats += Math.max(0, c - 1);
    if (perfectMode) deviation += Math.abs(c - 1);
  }

  // opponent repeats
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

/* ====== Local search ====== */
function randomSchedule(candidates, M, rng) {
  const sched = [];
  for (let i = 0; i < M; i++) sched.push(candidates[randInt(rng, candidates.length)]);
  return sched;
}

function improveSchedule(init, candidates, players, perfectMode, rng, deadlineMs) {
  let best = init.slice();
  let bestScore = scoreSchedule(best, players, perfectMode);

  // litt lavere enn Python-verdiene for å være kjapp på mobil
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

  const MAX_MS = 700; // total søkebudsjett per "Generer"
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

/* ====== Storage keys ====== */
function keys(planId) {
  return {
    scheduleKey: `padelplan_schedule_v1_${planId}`,
    winnersKey:  `padelplan_winners_v2_${planId}`, // per runde (kampvalg)
    scoresKey:   `padelplan_scores_v2_${planId}`,  // akkumulert
  };
}

/* ====== App state ====== */
let PLAN_ID = "";
let PLAYERS = [];
let MATCHES = [];  // [{a:[..], b:[..]}]
let WINNERS = {};  // {1:"A"/"B", ...} gjelder kun nåværende runde (kampvalg)
let SCORES = {};   // {player: number} akkumulert
let PERFECT_MODE = false;

function initEmptyScores(players) {
  const o = {};
  for (const p of players) o[p] = 0;
  return o;
}

function saveAll() {
  const { scheduleKey, winnersKey, scoresKey } = keys(PLAN_ID);
  localStorage.setItem(scheduleKey, JSON.stringify({
    planId: PLAN_ID,
    players: PLAYERS,
    matches: MATCHES,
    perfectMode: PERFECT_MODE,
    savedAt: new Date().toISOString(),
  }));
  localStorage.setItem(winnersKey, JSON.stringify(WINNERS));
  localStorage.setItem(scoresKey, JSON.stringify(SCORES));
}

function loadPlan(planId) {
  PLAN_ID = planId.trim();
  const { scheduleKey, winnersKey, scoresKey } = keys(PLAN_ID);

  const schedRaw = localStorage.getItem(scheduleKey);
  const winnersRaw = localStorage.getItem(winnersKey);
  const scoresRaw = localStorage.getItem(scoresKey);

  if (!schedRaw) {
    PLAYERS = [];
    MATCHES = [];
    PERFECT_MODE = false;
    WINNERS = {};
    SCORES = {};
    return false;
  }

  const sched = JSON.parse(schedRaw);
  PLAYERS = sched.players || [];
  MATCHES = sched.matches || [];
  PERFECT_MODE = !!sched.perfectMode;

  WINNERS = winnersRaw ? (JSON.parse(winnersRaw) || {}) : {};
  const loadedScores = scoresRaw ? JSON.parse(scoresRaw) : null;

  // sikre at alle spillere finnes i score
  SCORES = initEmptyScores(PLAYERS);
  if (loadedScores && typeof loadedScores === "object") {
    for (const [k, v] of Object.entries(loadedScores)) SCORES[k] = Number(v) || 0;
  }

  return true;
}

/* ====== Rendering ====== */
const el = (id) => document.getElementById(id);

function setStatus(msg) { el("status").textContent = msg; }

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

  // sett radio fra WINNERS
  for (let i = 1; i <= MATCHES.length; i++) {
    const v = WINNERS[i];
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

/* ====== Winner logic (delta) ====== */
function applyWinnerDelta(matchIndex, prevWinner, newWinner) {
  const m = MATCHES[matchIndex - 1];
  const addTeam = (team, delta) => {
    SCORES[team[0]] = (SCORES[team[0]] || 0) + delta;
    SCORES[team[1]] = (SCORES[team[1]] || 0) + delta;
  };

  if (prevWinner === "A") addTeam(m.a, -1);
  if (prevWinner === "B") addTeam(m.b, -1);
  if (newWinner === "A") addTeam(m.a, +1);
  if (newWinner === "B") addTeam(m.b, +1);
}

/* ====== UI actions ====== */
function parsePlayers(text) {
  const raw = text
    .split(/\r?\n|,/g)
    .map(s => s.trim())
    .filter(Boolean);

  // fjern duplikater (case-insensitive)
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

function generateNewSchedule(keepScore) {
  const players = parsePlayers(el("playersInput").value);
  if (players.length < 4 || players.length > 8) {
    setStatus("Du må ha mellom 4 og 8 unike spillere.");
    return;
  }
  PLAYERS = players;

  // seed basert på tidspunkt (gir variasjon)
  const seed = (Date.now() >>> 0);

  const res = buildSchedule(PLAYERS, seed);
  MATCHES = res.schedule;
  PERFECT_MODE = res.perfectMode;

  // Nytt oppsett = ny runde
  WINNERS = {};
  if (!keepScore) SCORES = initEmptyScores(PLAYERS);
  else {
    // sørg for at alle spillere finnes i score
    const next = initEmptyScores(PLAYERS);
    for (const [k, v] of Object.entries(SCORES)) next[k] = v;
    SCORES = next;
  }

  saveAll();
  renderSchedule();
}

function resetMatchesOnly() {
  // Ny runde: fjern kampvalg, behold score
  WINNERS = {};
  const { winnersKey } = keys(PLAN_ID);
  localStorage.removeItem(winnersKey);

  // uncheck radios
  for (let i = 1; i <= MATCHES.length; i++) {
    document.querySelectorAll(`input[name="w${i}"]`).forEach(r => r.checked = false);
  }
  saveAll();
  renderScores();
}

function resetAll() {
  // Nullstill kampvalg + score, behold oppsett
  WINNERS = {};
  SCORES = initEmptyScores(PLAYERS);

  const { winnersKey, scoresKey } = keys(PLAN_ID);
  localStorage.removeItem(winnersKey);
  localStorage.removeItem(scoresKey);

  for (let i = 1; i <= MATCHES.length; i++) {
    document.querySelectorAll(`input[name="w${i}"]`).forEach(r => r.checked = false);
  }
  saveAll();
  renderScores();
}

/* ====== Wiring ====== */
function todayISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,"0");
  const dd = String(d.getDate()).padStart(2,"0");
  return `${yyyy}-${mm}-${dd}`;
}

document.addEventListener("change", (e) => {
  const t = e.target;
  if (!t || !t.name || !t.name.startsWith("w")) return;

  const matchIndex = parseInt(t.name.slice(1), 10);
  if (!Number.isFinite(matchIndex)) return;

  const newWinner = t.value;           // A/B
  const prevWinner = WINNERS[matchIndex] || null;

  if (newWinner !== "A" && newWinner !== "B") return;

  applyWinnerDelta(matchIndex, prevWinner, newWinner);
  WINNERS[matchIndex] = newWinner;

  saveAll();
  renderScores();
});

window.addEventListener("load", () => {
  el("planId").value = todayISO();

  el("loadPlanBtn").addEventListener("click", () => {
    const pid = el("planId").value.trim() || todayISO();
    el("planId").value = pid;
    const ok = loadPlan(pid);
    if (!ok) {
      setStatus(`Ingen lagret plan for ${pid}. Lim inn spillere og trykk "Generer oppsett".`);
      el("scheduleWrap").style.display = "none";
      return;
    }
    el("playersInput").value = PLAYERS.join("\n");
    renderSchedule();
  });

  el("generateBtn").addEventListener("click", () => {
    const pid = el("planId").value.trim() || todayISO();
    el("planId").value = pid;
    PLAN_ID = pid;

    const keep = el("keepScore").checked;
    generateNewSchedule(keep);
  });

  el("newRoundBtn").addEventListener("click", () => {
    if (!MATCHES.length) return;
    resetMatchesOnly();
    setStatus(`Ny runde startet (poeng beholdt) • Plan ${PLAN_ID}`);
  });

  el("resetAllBtn").addEventListener("click", () => {
    if (!MATCHES.length && !PLAYERS.length) return;
    resetAll();
    setStatus(`Nullstilt kampvalg og poeng • Plan ${PLAN_ID}`);
  });

  // Auto-load dagens plan hvis den finnes
  const pid = el("planId").value.trim();
  if (loadPlan(pid)) {
    el("playersInput").value = PLAYERS.join("\n");
    renderSchedule();
  } else {
    setStatus(`Lim inn spillere og trykk "Generer oppsett". (Plan ${pid})`);
  }

});
