/* ===== Americano scheduler =====
 *
 * A "runde" is the number of matches needed for every pair of players to be
 * partners at least once: ceil(N(N-1)/2 pairs / (2 pairs per court · courts)).
 *
 * Each match is stored as a permutation of player indices: the first 4·c
 * positions play (court k = [4k,4k+1] vs [4k+2,4k+3]), the rest sit out.
 * Simulated annealing over swaps in these permutations minimises:
 *   - uneven number of matches played (hard-ish constraint)
 *   - partner pairs that never play together, and repeated partners
 *   - resting two matches in a row (also across the previous runde)
 *   - uneven opponent distribution
 * When nobody sits out (N = 4·c) we start from a cyclic round-robin, which
 * gives every pair exactly once, and only regroup pairs between courts.
 */

/* ===== Pure utilities ===== */
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

/* ===== Sizing ===== */
export function courtsInUse(numPlayers, numCourts) {
  return Math.max(0, Math.min(numCourts, Math.floor(numPlayers / 4)));
}

// Matches per runde: enough for every pair to be partners at least once.
export function matchesPerCycle(numPlayers, numCourts) {
  const c = courtsInUse(numPlayers, numCourts);
  if (!c) return 0;
  return Math.ceil(numPlayers * (numPlayers - 1) / (4 * c));
}

/* ===== Objective ===== */
const W = {
  SPREAD: 400,         // per match of difference beyond 1 between most/least played
  PLAY_VAR: 30,        // squared deviation from the mean number of matches
  PARTNER_MISSING: 40, // pair that never plays together
  PARTNER_REPEAT: 12,  // each extra time a pair plays together
  CONSEC_REST: 25,     // resting two matches in a row
  OPP_SQ: 1,           // sum of squared opponent counts (balances opponents)
};

function makeEvaluator(N, c, R, prevRest) {
  const PA = 4 * c;
  const rests = new Int32Array(N);
  const lastRest = new Int32Array(N);
  const part = new Int32Array(N * N);
  const opp = new Int32Array(N * N);
  const pk = (x, y) => (x < y ? x * N + y : y * N + x);
  const meanPlays = R * PA / N;

  return function evaluate(state) {
    rests.fill(0);
    lastRest.fill(-2);
    for (const p of prevRest) lastRest[p] = -1;
    part.fill(0);
    opp.fill(0);
    let consec = 0;

    for (let r = 0; r < R; r++) {
      const perm = state[r];
      for (let k = 0; k < c; k++) {
        const a0 = perm[4 * k], a1 = perm[4 * k + 1];
        const b0 = perm[4 * k + 2], b1 = perm[4 * k + 3];
        part[pk(a0, a1)]++; part[pk(b0, b1)]++;
        opp[pk(a0, b0)]++; opp[pk(a0, b1)]++;
        opp[pk(a1, b0)]++; opp[pk(a1, b1)]++;
      }
      for (let j = PA; j < N; j++) {
        const p = perm[j];
        rests[p]++;
        if (lastRest[p] === r - 1) consec++;
        lastRest[p] = r;
      }
    }

    let minP = Infinity, maxP = -Infinity, playVar = 0;
    for (let p = 0; p < N; p++) {
      const plays = R - rests[p];
      if (plays < minP) minP = plays;
      if (plays > maxP) maxP = plays;
      playVar += (plays - meanPlays) ** 2;
    }

    let missing = 0, repeats = 0, oppSq = 0;
    for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
      const n = part[i * N + j];
      if (n === 0) missing++; else repeats += n - 1;
      oppSq += opp[i * N + j] ** 2;
    }

    return W.SPREAD * Math.max(0, maxP - minP - 1) + W.PLAY_VAR * playVar +
      W.PARTNER_MISSING * missing + W.PARTNER_REPEAT * repeats +
      W.CONSEC_REST * consec + W.OPP_SQ * oppSq;
  };
}

/* ===== Initial states ===== */
// Rests rotate through a shuffled order: perfectly even and spread out.
// Players who rested last in the previous runde are put last in the queue.
function initialWithRests(N, c, R, prevRest, rng) {
  const PA = 4 * c, restPer = N - PA;
  const prev = new Set(prevRest);
  const order = [
    ...shuffle([...Array(N).keys()].filter(p => !prev.has(p)), rng),
    ...shuffle([...prev], rng),
  ];
  return Array.from({ length: R }, (_, r) => {
    const resting = new Set();
    for (let j = 0; j < restPer; j++) resting.add(order[(r * restPer + j) % N]);
    const active = shuffle(order.filter(p => !resting.has(p)), rng);
    return [...active, ...resting];
  });
}

// Classic round-robin "circle method": for N = 4c this yields N-1 matches in
// which every pair of players is partners exactly once.
function initialCyclic(N, R, rng) {
  const ids = shuffle([...Array(N).keys()], rng);
  const m = N - 1;
  return Array.from({ length: R }, (_, r) => {
    const ri = r % m;
    const at = i => ids[1 + ((i + ri) % m)];
    const perm = [ids[0], at(0)];
    for (let i = 1; i < N / 2; i++) perm.push(at(i), at(m - i));
    return perm;
  });
}

/* ===== Simulated annealing ===== */
function anneal(state, evaluate, { N, c, R, pairsOnly, rng, budgetMs }) {
  if (budgetMs <= 0) return state;
  const PA = 4 * c;
  let cur = evaluate(state);
  let best = cur;
  let bestState = state.map(p => p.slice());

  const T0 = 40, T1 = 0.05;
  const start = performance.now();
  let T = T0;

  for (let it = 0; ; it++) {
    if ((it & 255) === 0) {
      const f = (performance.now() - start) / budgetMs;
      if (f >= 1) break;
      T = T0 * Math.pow(T1 / T0, f);
    }

    const perm = state[randInt(rng, R)];
    let i, j;
    if (pairsOnly) {
      // Swap two partner pairs between courts: keeps partnerships intact
      const blocks = 2 * c;
      const bi = randInt(rng, blocks);
      let bj = randInt(rng, blocks - 1);
      if (bj >= bi) bj++;
      i = 2 * bi; j = 2 * bj;
      if ((i >> 2) === (j >> 2)) continue; // same court: no-op
      [perm[i], perm[j]] = [perm[j], perm[i]];
      [perm[i + 1], perm[j + 1]] = [perm[j + 1], perm[i + 1]];
    } else {
      i = randInt(rng, N);
      j = randInt(rng, N - 1);
      if (j >= i) j++;
      if (i >= PA && j >= PA) continue;                         // both resting
      if (i < PA && j < PA && (i >> 1) === (j >> 1)) continue;  // same team
      [perm[i], perm[j]] = [perm[j], perm[i]];
    }

    const next = evaluate(state);
    const delta = next - cur;
    if (delta <= 0 || rng() < Math.exp(-delta / T)) {
      cur = next;
      if (cur < best) { best = cur; bestState = state.map(p => p.slice()); }
    } else {
      // Undo
      [perm[i], perm[j]] = [perm[j], perm[i]];
      if (pairsOnly) [perm[i + 1], perm[j + 1]] = [perm[j + 1], perm[i + 1]];
    }
  }
  return bestState;
}

/* ===== Main export ===== */
// prevRestNames: players who sat out the last match of the previous runde,
// so they are not made to sit out the first match of this one.
export function buildSchedule(players, numCourts, seed, prevRestNames = []) {
  const N = players.length;
  const c = courtsInUse(N, numCourts);
  if (!c) return { rounds: [] };

  const R = matchesPerCycle(N, c);
  const rng = mulberry32(seed >>> 0);
  const idx = new Map(players.map((p, i) => [p, i]));
  const prevRest = prevRestNames.map(p => idx.get(p)).filter(i => i !== undefined);

  const pairsOnly = N === 4 * c;
  const initial = pairsOnly ? initialCyclic(N, R, rng) : initialWithRests(N, c, R, prevRest, rng);
  const evaluate = makeEvaluator(N, c, R, prevRest);
  const best = anneal(initial, evaluate, {
    N, c, R, pairsOnly, rng,
    budgetMs: pairsOnly && c === 1 ? 0 : 600,
  });

  // Firestore does not support nested arrays, so wrap each match as { courts }
  return {
    rounds: best.map(perm => ({
      courts: Array.from({ length: c }, (_, k) => ({
        a: [players[perm[4 * k]], players[perm[4 * k + 1]]],
        b: [players[perm[4 * k + 2]], players[perm[4 * k + 3]]],
      })),
    })),
  };
}

/* ===== A full new runde, continuing from the previous one ===== */
export function buildExtraRounds(players, courtsPerRound, seed, prevRestNames = []) {
  return buildSchedule(players, courtsPerRound, seed, prevRestNames).rounds;
}
