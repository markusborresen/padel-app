import { db, firebaseReady } from "./firebase.js";
import {
  collection, getDocs, orderBy, query, limit
} from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";

const el = id => document.getElementById(id);

function formatDate(timestamp) {
  if (!timestamp) return "–";
  const d = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
  return d.toLocaleDateString("no-NO", { day: "2-digit", month: "short", year: "numeric" });
}

function winPct(wins, matches) {
  if (!matches) return "–";
  return Math.round((wins / matches) * 100) + "%";
}

async function loadStats() {
  await firebaseReady;

  let docs;
  try {
    const q = query(
      collection(db, "history"),
      orderBy("completedAt", "desc"),
      limit(50)
    );
    const snap = await getDocs(q);
    docs = snap.docs.map(d => d.data());
  } catch (err) {
    console.error(err);
    el("loadingMsg").textContent = "Klarte ikke å laste statistikk.";
    return;
  }

  el("loadingMsg").style.display = "none";

  if (!docs.length) {
    el("emptyMsg").style.display = "block";
    return;
  }

  el("mainContent").style.display = "block";
  el("sessionCount").textContent = `${docs.length} avsluttede sesjon${docs.length === 1 ? "" : "er"} registrert`;

  /* ===== Aggregate leaderboard ===== */
  const playerStats = new Map(); // name -> { wins, matches }

  for (const data of docs) {
    const finalScores = data.finalScores || {};
    const totalMatches = data.totalMatches || {};

    for (const [player, wins] of Object.entries(finalScores)) {
      const cur = playerStats.get(player) || { wins: 0, matches: 0 };
      cur.wins += wins;
      cur.matches += (totalMatches[player] ?? 0);
      playerStats.set(player, cur);
    }
  }

  const sorted = [...playerStats.entries()].sort(([nameA, a], [nameB, b]) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    const pctA = a.matches ? a.wins / a.matches : 0;
    const pctB = b.matches ? b.wins / b.matches : 0;
    if (pctB !== pctA) return pctB - pctA;
    return nameA.localeCompare(nameB);
  });

  const tbody = el("leaderboardBody");
  sorted.forEach(([name, { wins, matches }], i) => {
    const tr = document.createElement("tr");
    if (i === 0) tr.className = "rank-1";
    tr.innerHTML = `
      <td class="rank-num">${i + 1}</td>
      <td class="player-name">${name}</td>
      <td>${wins}</td>
      <td>${matches}</td>
      <td>${winPct(wins, matches)}</td>
    `;
    tbody.appendChild(tr);
  });

  /* ===== Recent sessions ===== */
  const recentContainer = el("recentSessions");
  for (const data of docs.slice(0, 10)) {
    const finalScores = data.finalScores || {};
    const topPlayers = Object.entries(finalScores)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([p, pts]) => `${p} (${pts})`)
      .join(", ");

    const numRounds = (data.rounds || []).length;
    const numCourts = data.numCourts || 1;
    const dateStr = formatDate(data.completedAt);

    const div = document.createElement("div");
    div.style.cssText = "border:1px solid #eee; border-radius:10px; padding:10px 12px; margin-bottom:8px;";
    div.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:baseline;">
        <span style="font-size:13px; font-weight:700;">${(data.players || []).length} spillere · ${numRounds} runder · ${numCourts} bane${numCourts > 1 ? "r" : ""}</span>
        <span class="muted">${dateStr}</span>
      </div>
      <div class="muted" style="margin-top:4px;">Topp: ${topPlayers || "–"}</div>
    `;
    recentContainer.appendChild(div);
  }
}

window.addEventListener("load", loadStats);
