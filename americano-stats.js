import { db, firebaseReady } from "./firebase.js";
import {
  collection, getDocs, deleteDoc, doc
} from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";

const el = id => document.getElementById(id);

function formatDate(timestamp) {
  if (!timestamp) return "–";
  const d = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
  return d.toLocaleDateString("no-NO", { day: "2-digit", month: "short", year: "numeric" });
}

function fmtAvg(points, rounds) {
  if (!rounds) return "–";
  return (points / rounds).toFixed(1);
}

async function loadStats() {
  try {
    await firebaseReady;
  } catch (err) {
    el("loadingMsg").textContent = "Klarte ikke å koble til Firebase: " + (err?.message || err);
    return;
  }

  let entries;
  try {
    const snap = await getDocs(collection(db, "history"));
    entries = snap.docs.map(d => ({ id: d.id, data: d.data() }));
  } catch (err) {
    console.error(err);
    el("loadingMsg").textContent = "Klarte ikke å laste statistikk.";
    return;
  }

  el("loadingMsg").style.display = "none";

  // Filter: only americano sessions
  const amEntries = entries
    .filter(({ data }) => data.mode === 'americano')
    .sort((a, b) => {
      const ta = a.data.completedAt?.toMillis?.() ?? 0;
      const tb = b.data.completedAt?.toMillis?.() ?? 0;
      return tb - ta;
    });

  if (!amEntries.length) {
    el("emptyMsg").style.display = "block";
    return;
  }

  el("mainContent").style.display = "block";
  el("sessionCount").textContent =
    `${amEntries.length} Americano-kamp${amEntries.length === 1 ? "" : "er"} registrert`;

  /* ===== Aggregate leaderboard: total points + rounds played ===== */
  // For americano: finalScores[player] = total points across all valid rounds
  // totalMatches[player] = number of rounds that player participated in
  const playerStats = new Map(); // name -> { points, rounds }

  for (const { data } of amEntries) {
    const finalScores = data.finalScores || {};
    const totalMatches = data.totalMatches || {};
    for (const [player, pts] of Object.entries(finalScores)) {
      const cur = playerStats.get(player) || { points: 0, rounds: 0 };
      cur.points += pts;
      cur.rounds += (totalMatches[player] ?? 0);
      playerStats.set(player, cur);
    }
  }

  // Sort by total points desc, then avg desc, then name asc
  const sorted = [...playerStats.entries()].sort(([nameA, a], [nameB, b]) => {
    if (b.points !== a.points) return b.points - a.points;
    const avgA = a.rounds ? a.points / a.rounds : 0;
    const avgB = b.rounds ? b.points / b.rounds : 0;
    if (avgB !== avgA) return avgB - avgA;
    return nameA.localeCompare(nameB);
  });

  const tbody = el("leaderboardBody");
  sorted.forEach(([name, { points, rounds }], i) => {
    const tr = document.createElement("tr");
    if (i === 0) tr.className = "rank-1";
    tr.innerHTML = `
      <td class="rank-num">${i + 1}</td>
      <td class="player-name">${name}</td>
      <td>${points}</td>
      <td>${rounds}</td>
      <td>${fmtAvg(points, rounds)}</td>
    `;
    tbody.appendChild(tr);
  });

  /* ===== Recent matches ===== */
  const recentContainer = el("recentSessions");
  for (const { data } of amEntries.slice(0, 20)) {
    const finalScores = data.finalScores || {};
    const ppr = data.pointsPerRound || "?";
    const topPlayers = Object.entries(finalScores)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([p, pts]) => `${p} (${pts})`)
      .join(", ");

    const numRounds = (data.rounds || []).length;
    const numCourts = data.numCourts || 1;
    const dateStr = formatDate(data.completedAt);
    const playerCount = (data.players || []).length;

    const div = document.createElement("div");
    div.style.cssText = [
      "border:1px solid #eee",
      "border-radius:10px",
      "padding:10px 12px",
      "margin-bottom:8px",
    ].join(";");

    div.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:baseline;">
        <span style="font-size:13px; font-weight:700;">
          ${playerCount} spillere · ${numRounds} runder · ${numCourts} bane${numCourts > 1 ? "r" : ""} · ${ppr} poeng/runde
        </span>
        <span class="muted">${dateStr}</span>
      </div>
      <div class="muted" style="margin-top:4px;">Topp: ${topPlayers || "–"}</div>
    `;
    recentContainer.appendChild(div);
  }
}

window.addEventListener("load", loadStats);
