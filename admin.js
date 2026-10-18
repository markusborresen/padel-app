import { db, firebaseReady, sessionRef, historyCol } from "./firebase.js";
import { computeResult } from "./results.js";
import {
  collection, query, where, onSnapshot,
  updateDoc, addDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";

const el = id => document.getElementById(id);

/* ── Helpers ── */
function formatTime(date) {
  return date.toLocaleTimeString("no-NO", { hour: "2-digit", minute: "2-digit" })
    + " " + date.toLocaleDateString("no-NO", { day: "2-digit", month: "2-digit" });
}

/* ── Render ── */
function renderSessions(sessions) {
  el("loadingMsg").style.display = "none";

  if (!sessions.length) {
    el("emptyMsg").style.display = "";
    el("sessionList").style.display = "none";
    return;
  }

  el("emptyMsg").style.display = "none";
  el("sessionList").style.display = "";

  el("sessionList").innerHTML = sessions
    .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0))
    .map(s => {
      const numRounds   = s.rounds?.length || 0;
      const curRound    = (s.currentRound || 0) + 1;
      const courts      = s.numCourts || 1;
      const isClassic   = s.mode && s.mode !== "americano";
      const created     = s.createdAt?.toDate ? formatTime(s.createdAt.toDate()) : "–";
      const players     = (s.players || []).join(", ");

      return `
      <div class="session-card">
        <div class="row" style="align-items:center; margin-bottom:4px;">
          <span class="session-pin">${s.pin}</span>
          <div class="spacer"></div>
          ${isClassic ? '<span class="mode-badge" style="background:#9ca3af; color:#fff;">Gammel klassisk</span>' : ""}
        </div>
        <div class="session-players">${players}</div>
        <div class="session-meta">${courts} bane${courts !== 1 ? "r" : ""} · Runde ${curRound}/${numRounds} · ${created}</div>
        <div class="row" style="margin-top:12px; gap:8px;">
          <a href="./match.html#pin=${s.pin}" class="btn" style="flex:1; text-align:center;">Åpne</a>
          <button class="btn danger" data-id="${s.id}" style="flex:1;">Avslutt</button>
        </div>
      </div>`;
    }).join("");

  // Attach end-session handlers
  el("sessionList").querySelectorAll("[data-id]").forEach(btn => {
    const session = sessions.find(s => s.id === btn.dataset.id);
    btn.addEventListener("click", () => endSession(session));
  });
}

/* ── End session (same result logic as match.js) ── */
async function endSession(session) {
  const { id, pin, rounds = [], winners = {}, players = [], mode } = session;
  const pointsPerRound = session.pointsPerRound || 32;

  // Old classic sessions are no longer supported: close without saving stats
  if (mode && mode !== "americano") {
    if (!confirm(`Avslutte gammel klassisk kamp PIN ${pin}?\n\nStatistikk lagres ikke.`)) return;
    try {
      await updateDoc(sessionRef(id), { status: "completed", updatedAt: serverTimestamp() });
    } catch (err) {
      console.error(err);
      alert("Feil ved avslutning: " + (err.message || err));
    }
    return;
  }

  const res = computeResult({
    rounds, winners, players, pointsPerRound, cycleLength: session.cycleLength,
  });
  const normalCount = rounds.filter(r => !r.final).length;
  const cycleWord = res.completedCycles === 1 ? "hel runde" : "hele runder";

  let msg = `Avslutte kamp PIN ${pin}?\n\n`
    + `${res.completedNormal} av ${normalCount} runder fullført · `
    + `${res.completedCycles} ${cycleWord} à ${res.cycleLen} runder.`;
  if (rounds.some(r => r.final)) msg += res.finaleDone ? "\nFinalen telles med." : "\nFinalen er ikke ferdig og telles ikke.";
  if (!res.validRounds.length) msg += "\n\nIngen fullstendige runder – ingen statistikk vil bli lagret.";

  if (!confirm(msg)) return;

  try {
    if (res.validRounds.length) {
      await addDoc(historyCol(), {
        pin, players,
        numCourts: rounds[0]?.courts?.length || 1,
        rounds: res.validRounds,
        winners: res.validWinners,
        finalScores: res.finalScores,
        totalMatches: res.totalMatches,
        mode: "americano",
        pointsPerRound,
        completedAt: serverTimestamp(),
      });
    }

    await updateDoc(sessionRef(id), {
      status: "completed",
      updatedAt: serverTimestamp(),
    });
    // onSnapshot removes the card automatically when status changes
  } catch (err) {
    console.error(err);
    alert("Feil ved avslutning: " + (err.message || err));
  }
}

/* ── Init ── */
async function init() {
  try {
    await firebaseReady;
  } catch (err) {
    el("loadingMsg").textContent = "Klarte ikke å koble til Firebase: " + (err?.message || err);
    return;
  }

  const q = query(collection(db, "sessions"), where("status", "==", "active"));
  onSnapshot(q, snap => {
    const sessions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderSessions(sessions);
  }, err => {
    el("loadingMsg").textContent = "Feil: " + (err?.message || err);
  });

  el("refreshBtn").addEventListener("click", () => {
    el("loadingMsg").style.display = "";
    el("sessionList").style.display = "none";
    el("emptyMsg").style.display = "none";
  });
}

init();
