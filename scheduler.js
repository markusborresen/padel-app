/* ===== Pure utilities ===== */
function gcd(a, b) { while (b) [a, b] = [b, a % b]; return Math.abs(a); }
function pairKey(x, y) { return x < y ? `${x}||${y}` : `${y}||${x}`; }

function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
function randInt(rng, n) { return Math.floor(rng() * n); }

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(rng, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ===== Match / candidate generation ===== */
function normalizeTeam(a, b) { return a < b ? [a, b] : [b, a]; }

function matchKey(m) {
  const ta = m.a.join("|");
  const tb = m.b.join("|");
  return ta < tb ? `${ta}__${tb}` : `${tb}__${ta}`;
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

function partitionsOfFour(p4) {
  const [p0, p1, p2, p3] = p4;
  return [
    [[p0, p1], [p2, p3]],
    [[p0, p2], [p1, p3]],
    [[p0, p3], [p1, p2]],
  ].map(([t1, t2]) => {
    const a = normalizeTeam(t1[0], t1[1]);
    const b = normalizeTeam(t2[0], t2[1]);
    const ta = a.join("|"), tb = b.join("|");
    return ta < tb ? { a, b } : { a: b, b: a };
  });
}

function generateCandidateMatches(players) {
  const uniq = new Map();
  for (const p4 of combinations4(players))
    for (const m of partitionsOfFour(p4))
      uniq.set(matchKey(m), m);
  return Array.from(uniq.values());
}

/* ===== Round builder ===== */
// Greedy: pick up to `courts` non-conflicting matches from candidates
function buildRandomRound(candidates, courts, rng) {
  const shuffled = shuffle(candidates, rng);
  const round = [];
  const used = new Set();
  for (const m of shuffled) {
    if (round.length >= courts) break;
    const ps = [...m.a, ...m.b];
    if (ps.every(p => !used.has(p))) {
      round.push(m);
      ps.forEach(p => used.add(p));
    }
  }
  return round;
}

/* ===== Schedule scoring ===== */
// Scores a flat list of matches (flatten rounds before calling)
const W = {
  PLAY_BALANCE: 12,
  PARTNER_MISSING: 28,
  PARTNER_REPEAT: 7,
  OPP_REPEAT: 2,
  CONSEC_REST: 1.5,
};

function scoreFlat(matches, players) {
  const N = players.length;
  const plays = new Map(players.map(p => [p, 0]));
  const partnerCounts = new Map();
  const oppCounts = new Map();
  const restStreak = new Map(players.map(p => [p, 0]));
  let restPen = 0;

  for (const m of matches) {
    const active = new Set([...m.a, ...m.b]);
    for (const p of active) plays.set(p, plays.get(p) + 1);

    const pk1 = pairKey(m.a[0], m.a[1]);
    const pk2 = pairKey(m.b[0], m.b[1]);
    partnerCounts.set(pk1, (partnerCounts.get(pk1) || 0) + 1);
    partnerCounts.set(pk2, (partnerCounts.get(pk2) || 0) + 1);
    for (const x of m.a) for (const y of m.b) {
      const ok = pairKey(x, y);
      oppCounts.set(ok, (oppCounts.get(ok) || 0) + 1);
    }

    for (const p of players) {
      if (active.has(p)) { restStreak.set(p, 0); }
      else {
        const s = restStreak.get(p) + 1;
        restStreak.set(p, s);
        if (s >= 2) restPen += (s - 1);
      }
    }
  }

  const vals = players.map(p => plays.get(p));
  const mean = vals.reduce((a, b) => a + b, 0) / N;
  const playVar = vals.reduce((acc, v) => acc + (v - mean) ** 2, 0) / N;

  let missing = 0, partnerRepeats = 0;
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
    const c = partnerCounts.get(pairKey(players[i], players[j])) || 0;
    if (c === 0) missing++;
    else partnerRepeats += c - 1;
  }

  let oppRepeats = 0;
  for (const c of oppCounts.values()) oppRepeats += Math.max(0, c - 1);

  return (
    W.PLAY_BALANCE * playVar +
    W.PARTNER_MISSING * (missing ** 2) +
    W.PARTNER_REPEAT * partnerRepeats +
    W.OPP_REPEAT * oppRepeats +
    W.CONSEC_REST * restPen
  );
}

/* ===== Sit-out rotation ===== */
// Pre-assigns who sits out per round so each player rests as evenly as possible.
// Returns array[numRounds] of resting-player arrays.
function buildSitOutRotation(players, numRounds, restPerRound, rng) {
  if (restPerRound <= 0) return Array.from({ length: numRounds }, () => []);

  const N = players.length;
  const totalRests = numRounds * restPerRound;
  const baseCount = Math.floor(totalRests / N);
  const extras = totalRests % N;

  // Each player rests baseCount times; `extras` players get one extra.
  const shuffledPlayers = shuffle(players, rng);
  const queue = [];
  shuffledPlayers.forEach((p, i) => {
    const count = baseCount + (i < extras ? 1 : 0);
    for (let j = 0; j < count; j++) queue.push(p);
  });

  // Shuffle queue so rest rounds are random, not sequential.
  const shuffledQueue = shuffle(queue, rng);

  return Array.from({ length: numRounds }, (_, r) =>
    shuffledQueue.slice(r * restPerRound, (r + 1) * restPerRound)
  );
}

/* ===== Main export ===== */
export function buildSchedule(players, numCourts, seed) {
  const N = players.length;
  if (N < 4) return { rounds: [] };

  const courtsPerRound = Math.min(numCourts, Math.floor(N / 4));
  const numRounds = Math.min(
    Math.max(Math.ceil(N * (N - 1) / (4 * courtsPerRound)), 4),
    20
  );

  const rng = mulberry32(seed >>> 0);

  // Pre-assign balanced sit-out rotation, then generate per-round candidates
  // from only the active players — this guarantees even rest distribution.
  const restPerRound = N - courtsPerRound * 4;
  const sitOutRotation = buildSitOutRotation(players, numRounds, restPerRound, rng);
  const perRoundCandidates = sitOutRotation.map(resting => {
    const restSet = new Set(resting);
    return generateCandidateMatches(players.filter(p => !restSet.has(p)));
  });

  // Build initial schedule
  let best = perRoundCandidates.map(cands =>
    buildRandomRound(cands, courtsPerRound, rng)
  );
  let bestScore = scoreFlat(best.flat(), players);

  const deadline = performance.now() + 900;
  while (performance.now() < deadline) {
    const next = best.slice();
    const idx = randInt(rng, numRounds);
    next[idx] = buildRandomRound(perRoundCandidates[idx], courtsPerRound, rng);
    const s = scoreFlat(next.flat(), players);
    if (s < bestScore) { best = next; bestScore = s; }
  }

  // Wrap each round as { courts: [...] } — Firestore does not support nested arrays
  return { rounds: best.map(courts => ({ courts })) };
}

/* ===== Generate one extra round ===== */
export function buildExtraRound(players, courtsPerRound, seed) {
  const N = players.length;
  if (N < 4) return null;
  const rng = mulberry32(seed >>> 0);
  const candidates = generateCandidateMatches(players);
  const courts = buildRandomRound(candidates, courtsPerRound, rng);
  return { courts };
}

/* ===== Generate a full extra set of rounds ===== */
export function buildExtraRounds(players, courtsPerRound, seed) {
  const N = players.length;
  if (N < 4) return [];
  const numRounds = Math.min(
    Math.max(Math.ceil(N * (N - 1) / (4 * courtsPerRound)), 4),
    20
  );
  const rng = mulberry32(seed >>> 0);
  const restPerRound = N - courtsPerRound * 4;
  const sitOutRotation = buildSitOutRotation(players, numRounds, restPerRound, rng);
  return sitOutRotation.map(resting => {
    const restSet = new Set(resting);
    const candidates = generateCandidateMatches(players.filter(p => !restSet.has(p)));
    return { courts: buildRandomRound(candidates, courtsPerRound, rng) };
  });
}
