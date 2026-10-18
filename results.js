/* Shared result logic for match.js and admin.js (Americano only). */

export function isRoundComplete(round, roundIdx, winners, pointsPerRound) {
  const courts = round?.courts || [];
  if (!courts.length) return false;
  return courts.every((_, ci) => {
    const w = winners?.[`${roundIdx}:${ci}`];
    return w && typeof w === "object" && (w.a + w.b) === pointsPerRound;
  });
}

export function allRoundsComplete(rounds, winners, pointsPerRound) {
  return rounds.length > 0 &&
    rounds.every((r, i) => isRoundComplete(r, i, winners, pointsPerRound));
}

// Finale: rank players by score, then per court group of four: #1+#4 vs #2+#3.
// Lowest-ranked players rest if they don't fill a court.
export function buildFinaleRound(players, scores, courtsPerRound) {
  const ranked = [...players].sort((a, b) =>
    ((scores[b] || 0) - (scores[a] || 0)) || a.localeCompare(b));
  const courts = [];
  for (let c = 0; c < courtsPerRound && (c + 1) * 4 <= ranked.length; c++) {
    const [p1, p2, p3, p4] = ranked.slice(c * 4, c * 4 + 4);
    courts.push({ a: [p1, p4], b: [p2, p3] });
  }
  return { courts, final: true };
}

// Which rounds count towards statistics: whole completed cycles of normal
// rounds, plus the finale if it is completed.
export function computeResult({ rounds = [], winners = {}, players = [],
                                pointsPerRound = 32, cycleLength = 0 }) {
  const normalIdx = [];
  const finaleIdx = [];
  rounds.forEach((r, i) => (r.final ? finaleIdx : normalIdx).push(i));

  let completedNormal = 0;
  for (const i of normalIdx) {
    if (isRoundComplete(rounds[i], i, winners, pointsPerRound)) completedNormal++;
    else break;
  }

  const cycleLen = cycleLength || normalIdx.length || 1;
  const completedCycles = Math.floor(completedNormal / cycleLen);
  const validIdx = normalIdx.slice(0, completedCycles * cycleLen);
  const finaleDone = finaleIdx.length > 0 &&
    finaleIdx.every(i => isRoundComplete(rounds[i], i, winners, pointsPerRound));
  if (finaleDone) validIdx.push(...finaleIdx);

  const finalScores = {};
  const totalMatches = {};
  const validWinners = {};
  for (const p of players) { finalScores[p] = 0; totalMatches[p] = 0; }

  validIdx.forEach((ri, newIdx) => {
    (rounds[ri].courts || []).forEach((match, ci) => {
      const w = winners[`${ri}:${ci}`];
      validWinners[`${newIdx}:${ci}`] = w;
      for (const p of match.a) {
        totalMatches[p] = (totalMatches[p] || 0) + 1;
        finalScores[p] = (finalScores[p] || 0) + w.a;
      }
      for (const p of match.b) {
        totalMatches[p] = (totalMatches[p] || 0) + 1;
        finalScores[p] = (finalScores[p] || 0) + w.b;
      }
    });
  });

  return {
    completedNormal, completedCycles, cycleLen, finaleDone,
    validRounds: validIdx.map(i => rounds[i]),
    validWinners, finalScores, totalMatches,
  };
}
