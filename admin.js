import { db, firebaseReady, sessionRef, historyCol } from "./firebase.js";
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

function isRoundComplete(roundData, roundIdx, winners) {
  const courts = roundData?.courts || [];
  return courts.length > 0 && courts.every((_, ci) => winners?.[`${roundIdx}:${ci}`] !== undefined);
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
      const isAmericano = s.mode === "americano";
      const created     = s.createdAt?.toDate ? formatTime(s.createdAt.toDate()) : "–";
      const players     = (s.players || []).join(", ");
      const badgeColor  = isAmericano ? "#7c3aed" : "#16a34a";
      const badgeLabel  = isAmericano ? "Americano" : "Klassisk";

      return `
      <div class="session-card">
        <div class="row" style="align-items:center; margin-bottom:4px;">
          <span class="session-pin">${s.pin}</span>
          <div class="spacer"></div>
          <span class="mode-badge" style="background:${badgeColor}; color:#fff;">${badgeLabel}</span>
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

/* ── End session (mirrors match.js endSession logic) ── */
async function endSession(session) {
  const { id, pin, rounds = [], winners = {}, players = [],
          mode, pointsPerRound, cycleLength } = session;

  // Count consecutive completed rounds from start
  let completedRoundCount = 0;
  for (let i = 0; i < rounds.length; i++) {
    if (isRoundComplete(rounds[i], i, winners)) completedRoundCount++;
    else break;
  }

  const cycleLen       = cycleLength || rounds.length;
  const completedCycles = Math.floor(completedRoundCount / cycleLen);
  const validRounds    = completedCycles * cycleLen;
  const cycleWord      = completedCycles === 1 ? "hel runde" : "hele runder";

  let msg = `Avslutte kamp PIN ${pin}?\n\n`
    + `${completedRoundCount} av ${rounds.length} runder fullført · `
    + `${completedCycles} ${cycleWord} à ${cycleLen} runder.`;
  if (validRounds === 0) {
    msg += "\n\nIngen fullstendige runder – ingen statistikk vil bli lagret.";
  } else {
    msg += `\nStatistikk telles fra runde 1–${validRounds}.`;
  }

  if (!confirm(msg)) return;

  try {
    if (validRounds > 0) {
      // Keep only winners within valid rounds
      const validWinners = {};
      for (const [key, val] of Object.entries(winners)) {
        if (parseInt(key.split(":")[0], 10) < validRounds) validWinners[key] = val;
      }

      // Recompute final scores from valid rounds
      const finalScores  = {};
      const totalMatches = {};
      for (const p of players) { finalScores[p] = 0; totalMatches[p] = 0; }

      for (let i = 0; i < validRounds; i++) {
        for (let ci = 0; ci < (rounds[i]?.courts || []).length; ci++) {
          const match = rounds[i].courts[ci];
          for (const p of [...match.a, ...match.b]) totalMatches[p] = (totalMatches[p] || 0) + 1;
          const w = validWinners[`${i}:${ci}`];
          if (mode === "americano" && w && typeof w === "object") {
            for (const p of match.a) finalScores[p] = (finalScores[p] || 0) + w.a;
            for (const p of match.b) finalScores[p] = (finalScores[p] || 0) + w.b;
          } else if (mode === "classic") {
            if (w === "A") { finalScores[match.a[0]]++; finalScores[match.a[1]]++; }
            if (w === "B") { finalScores[match.b[0]]++; finalScores[match.b[1]]++; }
          }
        }
      }

      const historyEntry = {
        pin, players,
        numCourts: rounds[0]?.courts?.length || 1,
        rounds: rounds.slice(0, validRounds),
        winners: validWinners,
        finalScores, totalMatches,
        mode: mode || "classic",
        completedAt: serverTimestamp(),
      };
      // Only include optional fields if they are defined (old sessions may lack them)
      if (pointsPerRound !== undefined) historyEntry.pointsPerRound = pointsPerRound;
      await addDoc(historyCol(), historyEntry);
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
