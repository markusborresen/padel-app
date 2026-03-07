import { db, firebaseReady } from "./firebase.js";
import {
  doc, getDoc
} from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";

const el = id => document.getElementById(id);

function formatDateTime(timestamp) {
  if (!timestamp) return "–";
  const d = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
  return d.toLocaleString("no-NO", {
    weekday: "long", day: "2-digit", month: "long", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  });
}

async function loadKamp() {
  try {
    await firebaseReady;
  } catch (err) {
    el("loadingMsg").textContent = "Klarte ikke å koble til Firebase.";
    return;
  }

  const docId = new URLSearchParams(location.search).get("id");
  if (!docId) {
    el("loadingMsg").textContent = "Ingen kamp-ID funnet. Gå tilbake til statistikk.";
    return;
  }

  let data;
  try {
    const snap = await getDoc(doc(db, "history", docId));
    if (!snap.exists()) {
      el("loadingMsg").textContent = "Fant ikke kampen.";
      return;
    }
    data = snap.data();
  } catch (err) {
    console.error(err);
    el("loadingMsg").textContent = "Klarte ikke å laste kampen: " + (err?.message || err);
    return;
  }

  el("loadingMsg").style.display = "none";
  el("mainContent").style.display = "block";

  const players = data.players || [];
  const rounds = data.rounds || [];     // [{ courts: [{a,b}, ...] }, ...]
  const winners = data.winners || {};
  const finalScores = data.finalScores || {};
  const numCourts = data.numCourts || 1;

  // Date
  el("kampDate").textContent = formatDateTime(data.completedAt);

  // Meta grid
  const totalMatches = rounds.reduce((sum, r) => sum + (r.courts || []).length, 0);
  el("metaGrid").innerHTML = `
    <div class="meta-cell"><div class="meta-label">Spillere</div><div class="meta-value">${players.length}</div></div>
    <div class="meta-cell"><div class="meta-label">Runder</div><div class="meta-value">${rounds.length}</div></div>
    <div class="meta-cell"><div class="meta-label">Baner</div><div class="meta-value">${numCourts}</div></div>
    <div class="meta-cell"><div class="meta-label">Totale kamper</div><div class="meta-value">${totalMatches}</div></div>
  `;

  // Players list
  el("playersList").innerHTML = players
    .map(p => `<span class="pill" style="margin-bottom:6px;">${p}</span>`)
    .join(" ");

  // Final scores
  const scoreEntries = Object.entries(finalScores)
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
  el("finalScores").innerHTML = scoreEntries
    .map(([p, pts]) => `<div class="score-row"><span class="pill">${pts}</span>${p}</div>`)
    .join("");

  // Rounds
  const roundsList = el("roundsList");
  rounds.forEach((round, roundIdx) => {
    const courts = round.courts || [];
    const block = document.createElement("div");
    block.className = "round-block";
    block.innerHTML = `<div class="round-block-header">Runde ${roundIdx + 1}</div>`;

    courts.forEach((match, courtIdx) => {
      const key = `${roundIdx}:${courtIdx}`;
      const winner = winners[key] || null;

      const teamANames = `${match.a[0]} &amp; ${match.a[1]}`;
      const teamBNames = `${match.b[0]} &amp; ${match.b[1]}`;

      let winnerLabel;
      if (winner === "A") {
        winnerLabel = `<span class="winner-tag">🏆 ${match.a[0]} &amp; ${match.a[1]}</span>`;
      } else if (winner === "B") {
        winnerLabel = `<span class="winner-tag">🏆 ${match.b[0]} &amp; ${match.b[1]}</span>`;
      } else {
        winnerLabel = `<span class="winner-tag none">Ingen vinner</span>`;
      }

      const row = document.createElement("div");
      row.className = "match-row";
      row.innerHTML = `
        <span class="court-tag">Bane ${courtIdx + 1}</span>
        <span class="match-teams">${teamANames} <span style="color:#aaa;font-size:12px;">vs</span> ${teamBNames}</span>
        ${winnerLabel}
      `;
      block.appendChild(row);
    });

    // Resting players this round
    const activePlayers = new Set(courts.flatMap(m => [...m.a, ...m.b]));
    const resting = players.filter(p => !activePlayers.has(p));
    if (resting.length) {
      const restDiv = document.createElement("div");
      restDiv.style.cssText = "padding:6px 12px 8px; font-size:12px; color:#999; border-top:1px solid #f0f0f0;";
      restDiv.textContent = `Hviler: ${resting.join(", ")}`;
      block.appendChild(restDiv);
    }

    roundsList.appendChild(block);
  });
}

window.addEventListener("load", loadKamp);
