#!/usr/bin/env python3
"""
Americano Padel - Automatisert testsuite
Reimplementerer scheduler.js-logikken og simulerer fulle kamper.

Tester:
  - 5 spillere, 1 bane, 16 poeng/runde
  - 8 spillere, 2 baner, 32 poeng/runde

For hvert scenario: 3 komplette kamper med tilfeldige scores.
"""

import random
import math
import ctypes
from collections import defaultdict
from itertools import combinations

# ─────────────────────────────────────────────────────────────
# RNG: mulberry32  (port av JS-implementasjonen)
# ─────────────────────────────────────────────────────────────
def _imul(a, b):
    """JavaScript Math.imul  – 32-bit signed integer multiplication."""
    return ctypes.c_int32((int(a) * int(b)) & 0xFFFFFFFF).value

def mulberry32(seed):
    """Returns a closure that behaves like the JS mulberry32 RNG."""
    t = [int(seed) & 0xFFFFFFFF]

    def rng():
        t[0] = (t[0] + 0x6D2B79F5) & 0xFFFFFFFF
        r = _imul(t[0] ^ (t[0] >> 15), 1 | t[0])
        r ^= r + _imul(r ^ (r >> 7), 61 | r)
        r = r & 0xFFFFFFFF          # >>> 0
        return ((r ^ (r >> 14)) & 0xFFFFFFFF) / 4294967296.0

    return rng

def rand_int(rng, n):
    return int(rng() * n)

def shuffle(arr, rng):
    a = list(arr)
    for i in range(len(a) - 1, 0, -1):
        j = rand_int(rng, i + 1)
        a[i], a[j] = a[j], a[i]
    return a

# ─────────────────────────────────────────────────────────────
# Kandidatgenerering  (kombinasjoner4 + partisjoner)
# ─────────────────────────────────────────────────────────────
def normalize_team(a, b):
    return (a, b) if a < b else (b, a)

def match_key(m):
    ta = "|".join(m["a"])
    tb = "|".join(m["b"])
    return f"{ta}__{tb}" if ta < tb else f"{tb}__{ta}"

def partitions_of_four(p4):
    p0, p1, p2, p3 = p4
    raw = [
        ((p0, p1), (p2, p3)),
        ((p0, p2), (p1, p3)),
        ((p0, p3), (p1, p2)),
    ]
    result = []
    for t1, t2 in raw:
        a = normalize_team(*t1)
        b = normalize_team(*t2)
        ta, tb = "|".join(a), "|".join(b)
        if ta < tb:
            result.append({"a": list(a), "b": list(b)})
        else:
            result.append({"a": list(b), "b": list(a)})
    return result

def generate_candidate_matches(players):
    uniq = {}
    for p4 in combinations(players, 4):
        for m in partitions_of_four(p4):
            k = match_key(m)
            if k not in uniq:
                uniq[k] = m
    return list(uniq.values())

# ─────────────────────────────────────────────────────────────
# Rundebygger
# ─────────────────────────────────────────────────────────────
def build_random_round(candidates, courts, rng):
    shuffled = shuffle(candidates, rng)
    round_courts = []
    used = set()
    for m in shuffled:
        if len(round_courts) >= courts:
            break
        ps = m["a"] + m["b"]
        if all(p not in used for p in ps):
            round_courts.append(m)
            used.update(ps)
    return round_courts

# ─────────────────────────────────────────────────────────────
# Poengsetting av timeplan (lavere = mer rettferdig)
# ─────────────────────────────────────────────────────────────
W = {
    "PLAY_BALANCE":    12,
    "PARTNER_MISSING": 28,
    "PARTNER_REPEAT":   7,
    "OPP_REPEAT":       2,
    "CONSEC_REST":      1.5,
}

def pair_key(x, y):
    return (x, y) if x < y else (y, x)

def score_flat(matches, players):
    N = len(players)
    plays = defaultdict(int)
    partner_counts = defaultdict(int)
    opp_counts = defaultdict(int)
    rest_streak = defaultdict(int)
    rest_pen = 0

    for m in matches:
        active = set(m["a"] + m["b"])
        for p in active:
            plays[p] += 1

        partner_counts[pair_key(m["a"][0], m["a"][1])] += 1
        partner_counts[pair_key(m["b"][0], m["b"][1])] += 1
        for x in m["a"]:
            for y in m["b"]:
                opp_counts[pair_key(x, y)] += 1

        for p in players:
            if p in active:
                rest_streak[p] = 0
            else:
                rest_streak[p] += 1
                s = rest_streak[p]
                if s >= 2:
                    rest_pen += (s - 1)

    vals = [plays[p] for p in players]
    mean = sum(vals) / N
    play_var = sum((v - mean) ** 2 for v in vals) / N

    missing = 0
    partner_repeats = 0
    for i, pi in enumerate(players):
        for j in range(i + 1, N):
            pj = players[j]
            c = partner_counts.get(pair_key(pi, pj), 0)
            if c == 0:
                missing += 1
            else:
                partner_repeats += c - 1

    opp_repeats = sum(max(0, c - 1) for c in opp_counts.values())

    return (
        W["PLAY_BALANCE"]    * play_var
        + W["PARTNER_MISSING"] * (missing ** 2)
        + W["PARTNER_REPEAT"]  * partner_repeats
        + W["OPP_REPEAT"]      * opp_repeats
        + W["CONSEC_REST"]     * rest_pen
    )

# ─────────────────────────────────────────────────────────────
# Pause-rotasjon  (tilsvarer buildSitOutRotation i JS)
# ─────────────────────────────────────────────────────────────
def build_sit_out_rotation(players, num_rounds, rest_per_round, rng):
    """Pre-tildeler hvem som sitter ute per runde, jevnt fordelt."""
    if rest_per_round <= 0:
        return [[] for _ in range(num_rounds)]

    N = len(players)
    total_rests = num_rounds * rest_per_round
    base_count = total_rests // N
    extras = total_rests % N

    # Hvert spillers hvileantall: base_count eller base_count+1
    shuffled_players = shuffle(players, rng)
    queue = []
    for i, p in enumerate(shuffled_players):
        count = base_count + (1 if i < extras else 0)
        for _ in range(count):
            queue.append(p)

    # Bland køen for å randomisere hvilke runder hver spiller hviler
    shuffled_queue = shuffle(queue, rng)

    return [
        shuffled_queue[r * rest_per_round:(r + 1) * rest_per_round]
        for r in range(num_rounds)
    ]

# ─────────────────────────────────────────────────────────────
# Deterministisk plan for n=4k spillere  (tilsvarer JS)
# ─────────────────────────────────────────────────────────────

def pairs_to_match(pair1, pair2):
    """Konverterer to partner-par til et normalisert kamp-objekt."""
    a = normalize_team(*pair1)
    b = normalize_team(*pair2)
    ta, tb = "|".join(a), "|".join(b)
    if ta < tb:
        return {"a": list(a), "b": list(b)}
    return {"a": list(b), "b": list(a)}

def all_court_groupings(pairs, k):
    """Alle måter å dele 2k partner-par inn i k kamper."""
    if k == 1:
        return [[pairs_to_match(pairs[0], pairs[1])]]
    if k == 2:
        return [
            [pairs_to_match(pairs[0], pairs[1]), pairs_to_match(pairs[2], pairs[3])],
            [pairs_to_match(pairs[0], pairs[2]), pairs_to_match(pairs[1], pairs[3])],
            [pairs_to_match(pairs[0], pairs[3]), pairs_to_match(pairs[1], pairs[2])],
        ]
    # Generelt tilfelle
    results = []
    def gen(rem, cur):
        if not rem:
            results.append(cur[:])
            return
        first = rem[0]
        for i in range(1, len(rem)):
            cur.append(pairs_to_match(first, rem[i]))
            gen([x for j, x in enumerate(rem) if j != 0 and j != i], cur)
            cur.pop()
    gen(list(pairs), [])
    return results

def build_cyclic_partner_pairs(players, courts_per_round, num_rounds):
    """Syklisk 'én fast spiller'-konstruksjon. Perfekt partner-dekning for n=4k."""
    n = len(players)
    m = n - 1
    result = []
    for r in range(num_rounds):
        ri = r % m
        def c_idx(i, ri=ri): return players[1 + (i + ri) % m]
        pairs = [(players[0], c_idx(0))]
        for i in range(1, math.ceil(m / 2)):
            pairs.append((c_idx(i), c_idx(m - i)))
        result.append(pairs)
    return result

def build_deterministic_schedule(players, courts_per_round, num_rounds):
    """Fase 1 (syklisk) + Fase 2 (uttømmende bane-gruppering)."""
    partner_sets = build_cyclic_partner_pairs(players, courts_per_round, num_rounds)
    round_options = [all_court_groupings(ps, courts_per_round) for ps in partner_sets]
    total = 1
    for opts in round_options: total *= len(opts)

    if total <= 50000:
        # Uttømmende søk — garantert optimal motstanderbalanse; typisk < 5 ms
        best = [None] * num_rounds
        best_score = [float("inf")]

        def search(r, current):
            if r == num_rounds:
                flat = [m for rnd in current for m in rnd]
                s = score_flat(flat, players)
                if s < best_score[0]:
                    best_score[0] = s
                    best[:] = [rnd[:] for rnd in current]
                return
            for opt in round_options[r]:
                current.append(opt)
                search(r + 1, current)
                current.pop()

        search(0, [])
        return best

    # Stort tilfelle: stokastisk optimering av kun bane-grupperinger
    rng = mulberry32(0)
    sched = [opts[rand_int(rng, len(opts))] for opts in round_options]
    best_score = score_flat([m for rnd in sched for m in rnd], players)
    for _ in range(20000):
        idx = rand_int(rng, num_rounds)
        opts = round_options[idx]
        if len(opts) <= 1: continue
        cand = sched[:]
        cand[idx] = opts[rand_int(rng, len(opts))]
        s = score_flat([m for rnd in cand for m in rnd], players)
        if s < best_score:
            sched = cand
            best_score = s
    return sched

# ─────────────────────────────────────────────────────────────
# Planlegger  (tilsvarer buildSchedule i JS)
# ─────────────────────────────────────────────────────────────
OPTIMIZE_ITERATIONS = 15000  # JS bruker 1500 ms; vi bruker et fast antall iterasjoner

def build_schedule(players, num_courts, seed):
    N = len(players)
    if N < 4:
        return []
    courts_per_round = min(num_courts, N // 4)
    num_rounds = min(max(math.ceil(N * (N - 1) / (4 * courts_per_round)), 4), 20)

    rest_per_round = N - courts_per_round * 4

    if rest_per_round == 0:
        # Alle spillere aktive hver runde (n = 4k).
        # Fase 1: deterministisk syklisk konstruksjon → garantert perfekt partner-dekning.
        # Fase 2: uttømmende søk over bane-grupperinger → optimal motstanderbalanse.
        return build_deterministic_schedule(players, courts_per_round, num_rounds)

    # Har pauser: stokastisk hill-climbing med perturbering og restart.
    rng = mulberry32(seed)
    sit_out_rotation = build_sit_out_rotation(players, num_rounds, rest_per_round, rng)
    per_round_candidates = []
    for resting in sit_out_rotation:
        rest_set = set(resting)
        active = [p for p in players if p not in rest_set]
        per_round_candidates.append(generate_candidate_matches(active))

    def build_fresh():
        return [build_random_round(c, courts_per_round, rng) for c in per_round_candidates]

    best = build_fresh()
    flat = [m for r in best for m in r]
    best_score = score_flat(flat, players)

    for _ in range(OPTIMIZE_ITERATIONS):
        r = rng()
        if r < 0.04:
            candidate = build_fresh()
        elif r < 0.24:
            candidate = best[:]
            i1 = rand_int(rng, num_rounds)
            i2 = rand_int(rng, num_rounds - 1)
            if i2 >= i1:
                i2 += 1
            candidate[i1] = build_random_round(per_round_candidates[i1], courts_per_round, rng)
            candidate[i2] = build_random_round(per_round_candidates[i2], courts_per_round, rng)
        else:
            candidate = best[:]
            idx = rand_int(rng, num_rounds)
            candidate[idx] = build_random_round(per_round_candidates[idx], courts_per_round, rng)

        flat = [m for r in candidate for m in r]
        s = score_flat(flat, players)
        if s < best_score:
            best = candidate
            best_score = s

    return best

# ─────────────────────────────────────────────────────────────
# Simulering av én kamp med tilfeldige scores
# ─────────────────────────────────────────────────────────────
def simulate_game(players, num_courts, points_per_round, seed):
    schedule = build_schedule(players, num_courts, seed)

    total_points   = defaultdict(int)
    rounds_played  = defaultdict(int)
    partner_with   = defaultdict(lambda: defaultdict(int))
    opponent_of    = defaultdict(lambda: defaultdict(int))
    sit_out        = defaultdict(int)
    rounds_log     = []

    for rnd_idx, courts in enumerate(schedule):
        playing = set()
        court_log = []
        for court_idx, m in enumerate(courts):
            team_a, team_b = m["a"], m["b"]
            playing |= set(team_a + team_b)

            # Tilfeldig score (a + b = points_per_round)
            a_pts = random.randint(0, points_per_round)
            b_pts = points_per_round - a_pts

            for p in team_a:
                total_points[p]  += a_pts
                rounds_played[p] += 1
            for p in team_b:
                total_points[p]  += b_pts
                rounds_played[p] += 1

            for p in team_a:
                for q in team_a:
                    if p != q:
                        partner_with[p][q] += 1
            for p in team_b:
                for q in team_b:
                    if p != q:
                        partner_with[p][q] += 1
            for p in team_a:
                for q in team_b:
                    opponent_of[p][q] += 1
                    opponent_of[q][p] += 1

            court_log.append(
                f"  Bane {court_idx+1}: "
                f"{' & '.join(team_a):20s} {a_pts:3d}  vs  "
                f"{b_pts:3d}  {' & '.join(team_b)}"
            )

        for p in players:
            if p not in playing:
                sit_out[p] += 1

        rounds_log.append((rnd_idx + 1, court_log, sorted(set(players) - playing)))

    return {
        "schedule":      schedule,
        "num_rounds":    len(schedule),
        "total_points":  dict(total_points),
        "rounds_played": dict(rounds_played),
        "partner_with":  {k: dict(v) for k, v in partner_with.items()},
        "opponent_of":   {k: dict(v) for k, v in opponent_of.items()},
        "sit_out":       dict(sit_out),
        "rounds_log":    rounds_log,
    }

# ─────────────────────────────────────────────────────────────
# Rapportformatering
# ─────────────────────────────────────────────────────────────
def ok(cond): return "[OK]" if cond else "[!!]"

def print_game_report(game_num, players, result, num_courts, points_per_round):
    N = len(players)
    print(f"\n{'-'*70}")
    print(f"  KAMP {game_num}  |  {N} spillere  |  {num_courts} bane(r)  "
          f"|  {points_per_round} poeng/runde  |  {result['num_rounds']} runder")
    print(f"{'-'*70}")

    # ── Runde-for-runde ──────────────────────────────────────
    print("\nRONDE-OVERSIKT:")
    for rnd_num, court_lines, resting in result["rounds_log"]:
        rest_str = f"  [pause: {', '.join(resting)}]" if resting else ""
        print(f"  Runde {rnd_num}:{rest_str}")
        for line in court_lines:
            print(f"   {line}")

    # ── Spillerstatistikk ────────────────────────────────────
    print("\nSPILLERSTATISTIKK:")
    header = f"  {'Spiller':<12}  {'Spilt':>5}  {'Pause':>5}  {'Poeng':>6}  {'Snitt':>6}"
    print(header)
    print("  " + "-" * (len(header) - 2))

    rp   = result["rounds_played"]
    sp   = result["sit_out"]
    pts  = result["total_points"]
    for p in players:
        played = rp.get(p, 0)
        sat    = sp.get(p, 0)
        points = pts.get(p, 0)
        avg    = points / played if played else 0
        print(f"  {p:<12}  {played:>5}  {sat:>5}  {points:>6}  {avg:>6.1f}")

    rounds_vals = [rp.get(p, 0) for p in players]
    diff = max(rounds_vals) - min(rounds_vals)
    print(f"\n  {ok(diff <= 1)} Rundedeltakelse: min={min(rounds_vals)}, "
          f"max={max(rounds_vals)}, diff={diff}")

    # ── Lagkamerat-matrise ───────────────────────────────────
    print("\nLAGKAMERAT-MATRISE (antall ganger på lag sammen):")
    col_w = max(len(p) for p in players) + 2
    print("  " + " " * 12, end="")
    for p in players:
        print(f"{p[:col_w]:>{col_w}}", end="")
    print()
    for p in players:
        print(f"  {p:<12}", end="")
        for q in players:
            if p == q:
                print(f"{'--':>{col_w}}", end="")
            else:
                cnt = result["partner_with"].get(p, {}).get(q, 0)
                print(f"{cnt:>{col_w}}", end="")
        print()

    partner_pairs = [
        result["partner_with"].get(p, {}).get(q, 0)
        for i, p in enumerate(players)
        for j, q in enumerate(players)
        if i < j
    ]
    if partner_pairs:
        mn, mx = min(partner_pairs), max(partner_pairs)
        zero_pairs = sum(1 for c in partner_pairs if c == 0)
        total_pairs = len(partner_pairs)
        print(f"\n  {ok(mn >= 1)} Alle par har vært lagkamerater: "
              f"{total_pairs - zero_pairs}/{total_pairs} par oppfylt  "
              f"(min={mn}, max={mx})")

    # ── Motstandermatrise (komprimert) ───────────────────────
    opp_pairs = [
        result["opponent_of"].get(p, {}).get(q, 0)
        for i, p in enumerate(players)
        for j, q in enumerate(players)
        if i < j
    ]
    if opp_pairs:
        mn, mx = min(opp_pairs), max(opp_pairs)
        zero_opp = sum(1 for c in opp_pairs if c == 0)
        total_opp = len(opp_pairs)
        print(f"  {ok(mn >= 1)} Alle par har møtt hverandre: "
              f"{total_opp - zero_opp}/{total_opp} par oppfylt  "
              f"(min={mn}, max={mx})")


def run_scenario(label, players, num_courts, points_per_round, num_games=3):
    print(f"\n\n{'='*70}")
    print(f"  SCENARIO: {label}")
    print(f"  Spillere ({len(players)}): {', '.join(players)}")
    expected_courts_per_round = min(num_courts, len(players) // 4)
    N = len(players)
    expected_rounds = min(
        max(math.ceil(N * (N - 1) / (4 * expected_courts_per_round)), 4), 20
    )
    print(f"  Forventet antall runder per kamp: {expected_rounds}")
    print(f"{'='*70}")

    for game_num in range(1, num_games + 1):
        seed = (game_num * 31337 + hash(label)) & 0xFFFFFFFF
        result = simulate_game(players, num_courts, points_per_round, seed)
        print_game_report(game_num, players, result, num_courts, points_per_round)


# ─────────────────────────────────────────────────────────────
# Kjør tester
# ─────────────────────────────────────────────────────────────
if __name__ == "__main__":
    random.seed(42)

    run_scenario(
        label="5 spillere - 1 bane - 16 poeng/runde",
        players=["Alice", "Bob", "Carlos", "Diana", "Erik"],
        num_courts=1,
        points_per_round=16,
        num_games=3,
    )

    run_scenario(
        label="8 spillere - 2 baner - 32 poeng/runde",
        players=["Alice", "Bob", "Carlos", "Diana", "Erik", "Fiona", "Gustav", "Hanna"],
        num_courts=2,
        points_per_round=32,
        num_games=3,
    )
