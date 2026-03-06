import {
  db, firebaseReady, getDocIdFromPin, sessionRef, generatePin6
} from "./firebase.js";
import { buildSchedule } from "./scheduler.js";
import {
  runTransaction, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";

/* ===== View switching ===== */
function showView(name) {
  for (const id of ["viewHome", "viewCreate", "viewJoin", "viewLoading"]) {
    document.getElementById(id).classList.toggle("active", id === name);
  }
}

/* ===== Helpers ===== */
function parsePlayers(text) {
  const raw = text.split(/\r?\n|,/g).map(s => s.trim()).filter(Boolean);
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

function initScores(players) {
  const o = {};
  for (const p of players) o[p] = 0;
  return o;
}

/* ===== Create session ===== */
async function createSession(playersText, numCourts) {
  await firebaseReady;

  const players = parsePlayers(playersText);
  if (players.length < 4) {
    alert("Du trenger minst 4 spillere.");
    return;
  }

  showView("viewLoading");

  const seed = Date.now() >>> 0;
  const { rounds } = buildSchedule(players, numCourts, seed);

  if (!rounds.length) {
    alert("Klarte ikke å lage kampprogram. Sjekk antall spillere og baner.");
    showView("viewCreate");
    return;
  }

  for (let attempt = 0; attempt < 10; attempt++) {
    const pin = generatePin6();
    const docId = await getDocIdFromPin(pin);
    const ref = sessionRef(docId);

    try {
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        if (snap.exists()) throw new Error("PIN_COLLISION");

        tx.set(ref, {
          pin,
          players,
          numCourts,
          rounds,
          currentRound: 0,
          winners: {},
          scores: initScores(players),
          status: "active",
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        }, { merge: false });
      });

      window.location.href = `./match.html#pin=${pin}`;
      return;
    } catch (err) {
      if ((err?.message || "") === "PIN_COLLISION") continue;
      console.error(err);
      alert(err?.message || "Noe gikk galt. Prøv igjen.");
      showView("viewCreate");
      return;
    }
  }

  alert("Klarte ikke å generere unik PIN. Prøv igjen.");
  showView("viewCreate");
}

/* ===== Wiring ===== */
window.addEventListener("load", () => {
  document.getElementById("goCreateBtn").addEventListener("click", () => showView("viewCreate"));
  document.getElementById("goJoinBtn").addEventListener("click", () => showView("viewJoin"));
  document.getElementById("createBackBtn").addEventListener("click", () => showView("viewHome"));
  document.getElementById("joinBackBtn").addEventListener("click", () => showView("viewHome"));

  document.getElementById("createStartBtn").addEventListener("click", async () => {
    const text = document.getElementById("createPlayers").value;
    const courts = parseInt(document.getElementById("createCourts").value, 10);
    await createSession(text, courts);
  });

  document.getElementById("joinStartBtn").addEventListener("click", () => {
    const pin = document.getElementById("joinPin").value.trim();
    if (!pin) { alert("Skriv inn PIN."); return; }
    window.location.href = `./match.html#pin=${pin}`;
  });
});
