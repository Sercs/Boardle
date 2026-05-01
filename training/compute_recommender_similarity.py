"""
compute_recommender_similarity.py

Extracts cosine embeddings from the trained GenerativeRecommender and builds
a top-K similarity matrix with one-hold-difference deduplication.

Output: public/topk_similarity.json (same format as existing similarity files)
"""

import torch
import torch.nn.functional as F
import sqlite3, re, json, random
import numpy as np
from tqdm import tqdm

from train_recommender import (
    GenerativeRecommender,
    MAX_TOKENS, HOLD_VOCAB, ROLE_VOCAB, JOINT_VOCAB,
    NUM_GRADES, NUM_ANGLES, VOCAB_SIZE, NUM_ROLES,
    MASK_ID, START_ID, CLS_ID, PAD_ID, MASK_ROLE,
)

# --- CONFIG ---
DB_PATH      = 'public/tension.sqlite3'
MODEL_PATH   = 'recommender_best.pth'
OUTPUT_PATH  = 'public/topk_similarity.json'
LAYOUT_ID    = 11
TOP_K        = 100
BUFFER_K     = 300      # Oversample before dedup
CHUNK_SIZE   = 512      # Rows per similarity chunk (tune to VRAM)
BATCH_SIZE   = 256      # Climbs per embedding batch
MASK_GRADE_INF = True   # If True, finds similarities regardless of difficulty
MASK_ANGLE_INF = True   # If True, finds similarities across different wall angles
RECOMMEND_ONLY_GRADED = True # If True, suggestions ONLY contain graded climbs


# ======================== DATA LOADING ========================

def load_climbs(db_path, layout_id):
    """
    Load ALL app-visible climbs for embedding.
    - One canonical entry per unique frameset (for embedding efficiency)
    - Builds frames→[all_uuids] alias map so every UUID gets a similarity entry
    - Graded climbs use actual grade_bin; ungraded use MASK_GRADE
    """
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    # Hold coord cache
    cursor.execute("SELECT p.id, h.x, h.y FROM placements p JOIN holes h ON p.hole_id = h.id")
    cache = {row[0]: {'x': row[1] / 88.0, 'y': row[2] / 152.0} for row in cursor.fetchall()}

    # Mirror map
    cursor.execute("""
        SELECT p1.id, p2.id FROM placements p1
        JOIN holes h1 ON p1.hole_id = h1.id
        JOIN holes h2 ON h1.mirrored_hole_id = h2.id
        JOIN placements p2 ON p2.hole_id = h2.id
    """)
    mirror_map = dict(cursor.fetchall())
    role_map = {1:0, 5:0, 2:1, 6:1, 3:2, 7:2, 4:3, 8:3}

    # Grade lookup: best-quality stats per uuid (rn=1)
    cursor.execute("""
        SELECT climb_uuid, difficulty_average
        FROM (
            SELECT climb_uuid, difficulty_average,
                   ROW_NUMBER() OVER (PARTITION BY climb_uuid ORDER BY ascensionist_count DESC) as rn
            FROM climb_stats
        ) WHERE rn = 1
    """)
    grade_lookup = {row[0]: row[1] for row in cursor.fetchall()}

    # Load ALL app-visible climbs: uuid, frames, angle
    cursor.execute("""
        SELECT c.uuid, c.frames, c.angle, s.angle as stats_angle
        FROM climbs c
        LEFT JOIN (
            SELECT climb_uuid, angle,
                   ROW_NUMBER() OVER (PARTITION BY climb_uuid ORDER BY ascensionist_count DESC) as rn
            FROM climb_stats
        ) s ON c.uuid = s.climb_uuid AND s.rn = 1
        WHERE c.layout_id = ? AND c.is_draft = 0 AND c.is_listed = 1
        ORDER BY c.uuid
    """, (layout_id,))
    all_rows = cursor.fetchall()
    conn.close()

    # Build frames → list of all uuids (for alias expansion)
    frames_to_uuids = {}  # frames_str → [uuid, ...]
    for uuid, frames, angle, stats_angle in all_rows:
        frames_to_uuids.setdefault(frames, []).append(uuid)

    # One canonical entry per unique frameset
    p_regex = re.compile(r'p(\d+)r(\d+)')
    climbs = []   # canonical list for embedding
    uuid_to_idx = {}  # canonical uuid → index in climbs

    seen_frames = set()
    for uuid, frames, angle, stats_angle in all_rows:
        if frames in seen_frames:
            continue
        seen_frames.add(frames)

        holds = []
        for p_id, r_id in p_regex.findall(frames):
            p_id = int(p_id)
            if p_id in cache:
                holds.append({'id': p_id, 'role': role_map.get(int(r_id), 1)})
        if not holds:
            continue

        difficulty = grade_lookup.get(uuid)
        if difficulty is not None:
            grade_bin = max(0, min(NUM_GRADES - 1, int((difficulty - 10) / 2)))
        else:
            grade_bin = NUM_GRADES  # MASK_GRADE for ungraded

        # Use fallback angle: c.angle -> s.angle -> 40
        actual_angle = angle if angle is not None else stats_angle if stats_angle is not None else 40
        angle_bin = max(0, min(NUM_ANGLES - 1, int(actual_angle / 5)))
        hold_set = frozenset(h['id'] for h in holds)

        idx = len(climbs)
        climbs.append({
            'uuid': uuid, 'holds': holds,
            'grade_bin': grade_bin, 'angle_bin': angle_bin,
            'hold_set': hold_set, 'frames': frames,
            'is_graded': difficulty is not None
        })
        uuid_to_idx[uuid] = idx

    # Build alias map: for every UUID, which canonical index to use
    # (handles duplicate-frameset UUIDs)
    alias_map = {}  # all_uuid → canonical_uuid
    for frames, uuids in frames_to_uuids.items():
        # Find which uuid was chosen as canonical for this frameset
        canonical = None
        for u in uuids:
            if u in uuid_to_idx:
                canonical = u
                break
        if canonical is None:
            continue
        for u in uuids:
            alias_map[u] = canonical  # including canonical → itself

    print(f"Loaded {len(climbs)} canonical framesets covering {len(alias_map)} app UUIDs.")
    return climbs, cache, mirror_map, alias_map, uuid_to_idx


# ======================== SEQUENCE BUILDER ========================

def build_sequence(climb, cache, mirror_map, mirror=False):
    """
    Deterministic (no shuffle, no noise, no distractors) sequence for inference.
    Returns (in_ids, in_roles, coords_2d) as lists of length MAX_TOKENS.
    """
    holds = []
    for h in climb['holds']:
        h_id = h['id']
        role  = h['role']
        if mirror:
            h_id = mirror_map.get(h_id, h_id)
        coord = cache.get(h_id, {'x': 0.5, 'y': 0.5})
        x, y = coord['x'], coord['y']
        if mirror:
            m_coord = cache.get(mirror_map.get(h['id'], h['id']), {'x': x, 'y': y})
            x = m_coord['x']
        holds.append({'id': h_id, 'role': role, 'x': x, 'y': y})

    # Start-midpoint origin
    starts = [h for h in holds if h['role'] == 0]
    if starts:
        ox = sum(h['x'] for h in starts) / len(starts)
        oy = sum(h['y'] for h in starts) / len(starts)
    else:
        ox = sum(h['x'] for h in holds) / len(holds)
        oy = sum(h['y'] for h in holds) / len(holds)

    # [START, holds..., CLS, PAD...]
    in_ids   = [START_ID]
    in_roles = [MASK_ROLE]
    coords   = [[0.0, 0.0]]

    for h in holds:
        if len(in_ids) >= MAX_TOKENS - 1:  # Leave room for CLS
            break
        
        # Inference-time Start-Hold Ablation: Always mask start IDs
        # to ensure translation invariance and break start-hold bias.
        curr_id = MASK_ID if h['role'] == 0 else h['id']
        
        in_ids.append(curr_id)
        in_roles.append(h['role'])
        coords.append([h['x'] - ox, h['y'] - oy])

    # CLS
    in_ids.append(CLS_ID)
    in_roles.append(MASK_ROLE)
    coords.append([0.0, 0.0])

    # Pad
    curr = len(in_ids)
    if curr < MAX_TOKENS:
        pad_n = MAX_TOKENS - curr
        in_ids   += [PAD_ID]   * pad_n
        in_roles += [MASK_ROLE] * pad_n
        coords   += [[0.0, 0.0]] * pad_n

    return in_ids[:MAX_TOKENS], in_roles[:MAX_TOKENS], coords[:MAX_TOKENS], (ox, oy)


# ======================== EMBEDDING EXTRACTION ========================

@torch.no_grad()
def extract_embeddings(model, climbs, cache, mirror_map, device):
    """
    Run deterministic forward pass for orig + mirror variants.
    Returns:
        V     : [N, PROJ_DIM] normalized embeddings (original)
        Vm    : [N, PROJ_DIM] normalized embeddings (mirrored)
    """
    model.eval()
    causal_mask = torch.triu(
        torch.ones(MAX_TOKENS, MAX_TOKENS, device=device) * float('-inf'), diagonal=1
    )

    V, Vm = [], []

    for start in tqdm(range(0, len(climbs), BATCH_SIZE), desc="Extracting embeddings"):
        batch = climbs[start:start + BATCH_SIZE]
        B = len(batch)

        def make_tensors(mirror):
            ids_list, roles_list, coords_list, grades, angles, origins = [], [], [], [], [], []
            for c in batch:
                ids, roles, crds, orig = build_sequence(c, cache, mirror_map, mirror=mirror)
                ids_list.append(ids)
                roles_list.append(roles)
                coords_list.append(crds)
                
                # Agnostic Mode: use MASK indices to focus purely on movement vibe
                g_bin = NUM_GRADES if MASK_GRADE_INF else c['grade_bin']
                a_bin = NUM_ANGLES if MASK_ANGLE_INF else c['angle_bin']
                
                grades.append(g_bin)
                angles.append(a_bin)
                origins.append(orig)
            return (
                torch.tensor(ids_list,   dtype=torch.long,  device=device),
                torch.tensor(roles_list, dtype=torch.long,  device=device),
                torch.tensor(coords_list, dtype=torch.float32, device=device),
                torch.tensor(grades, dtype=torch.long, device=device),
                torch.tensor(angles, dtype=torch.long, device=device),
                torch.tensor(origins, dtype=torch.float32, device=device),
            )

        for mirror, store in [(False, V), (True, Vm)]:
            in_ids, in_roles, coords, grade, angle, origins = make_tensors(mirror)
            out = model(in_ids, in_roles, coords, grade, angle, origins, causal_mask)
            proj = F.normalize(out['proj'], dim=1)  # [B, PROJ_DIM]
            store.append(proj.cpu())

    return torch.cat(V, dim=0), torch.cat(Vm, dim=0)


# ======================== ONE-HOLD DEDUP ========================

def one_hold_different(set_a, set_b):
    """True if routes differ by exactly 0 or 1 hold (symmetric difference <= 2)."""
    return len(set_a.symmetric_difference(set_b)) <= 2


# ======================== SIMILARITY COMPUTATION ========================

def compute_similarity(V, Vm, climbs, device):
    """
    Chunked cosine similarity: sim(all, graded) = max(V_all·V_graded_orig, V_all·V_graded_mirr).
    Returns top_scores and top_indices relative to the GRADED subset.
    """
    N = V.shape[0]
    
    # Target set: Graded only OR All climbs based on config
    if RECOMMEND_ONLY_GRADED:
        graded_mask = torch.tensor([c['is_graded'] for c in climbs], dtype=torch.bool)
    else:
        graded_mask = torch.ones(N, dtype=torch.bool)
    
    V_target  = V[graded_mask].to(device)
    Vm_target = Vm[graded_mask].to(device)
    target_indices = torch.where(graded_mask)[0] # Map from target_idx to global canonical_idx
    
    Nt = V_target.shape[0]
    BK = min(BUFFER_K, Nt - 1)
    
    top_scores   = torch.zeros(N, BK)
    top_indices  = torch.zeros(N, BK, dtype=torch.long) # These will be indices into the TARGET set
    top_mirrored = torch.zeros(N, BK, dtype=torch.bool)

    V_all = V.to(device)

    for i in tqdm(range(0, N, CHUNK_SIZE), desc="Similarity chunks"):
        j = min(i + CHUNK_SIZE, N)
        chunk = V_all[i:j]             # [C, D]

        sim_orig = torch.mm(chunk, V_target.t())   # [C, Nt]
        sim_mirr = torch.mm(chunk, Vm_target.t())  # [C, Nt]

        # Take element-wise max
        sim_max  = torch.maximum(sim_orig, sim_mirr)   # [C, Nt]
        mirr_won = (sim_mirr > sim_orig)               # [C, Nt]

        # Mask self-similarity (if the query itself is in the target set)
        for k in range(j - i):
            global_idx = i + k
            # Find if global_idx exists in target_indices
            match = (target_indices == global_idx).nonzero(as_tuple=True)[0]
            if len(match) > 0:
                sim_max[k, match[0]] = -2.0

        scores, indices = torch.topk(sim_max, BK, dim=1)  # [C, BK]

        top_scores[i:j]   = scores.cpu()
        top_indices[i:j]  = indices.cpu()

        for k in range(j - i):
            top_mirrored[i + k] = mirr_won[k][indices[k]].cpu()

    return top_scores, top_indices, top_mirrored, target_indices


# ======================== MAIN ========================

def run():
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Using device: {device}")

    # 1. Load all climbs + alias map
    climbs, cache, mirror_map, alias_map, uuid_to_idx = load_climbs(DB_PATH, LAYOUT_ID)

    # 2. Load model
    model = GenerativeRecommender(cache).to(device)
    model.load_state_dict(torch.load(MODEL_PATH, map_location=device))
    model.eval()
    print(f"Loaded model from {MODEL_PATH}")

    # 3. Extract embeddings for canonical framesets
    V, Vm = extract_embeddings(model, climbs, cache, mirror_map, device)
    print(f"Embeddings: orig={V.shape}, mirr={Vm.shape}")

    # 4. Compute similarity (All vs Graded)
    top_scores, top_indices, top_mirrored, target_indices = compute_similarity(V, Vm, climbs, device)

    # 5. Build canonical UUID results with Greedy Diversity Filter
    print("Post-processing: greedy N-hold deduplication...")
    canonical_results = {}   # canonical_uuid → list of neighbours
    BK = top_scores.shape[1]
    DEDUP_N = 2 # Max symmetric difference to be considered a duplicate (1 hold)

    for i in tqdm(range(len(climbs)), desc="Diversity Filter"):
        query = climbs[i]
        q_set = query['hold_set']
        accepted = []

        for j in range(BK):
            if len(accepted) >= TOP_K:
                break
            
            # map target_idx back to global canonical index
            target_idx = top_indices[i, j].item()
            other_idx = target_indices[target_idx].item()
            other = climbs[other_idx]
            o_set = other['hold_set']

            # 1. Filter against Source
            if len(q_set ^ o_set) <= DEDUP_N:
                continue
            
            # 2. Filter against already accepted (Greedy Diversity)
            is_dup = False
            for prev in accepted:
                # We need a quick way to get the hold_set for already accepted uuids
                # query_idx is i, so we just check against the set of holds directly
                prev_climb = climbs[uuid_to_idx[prev['uuid']]]
                if len(o_set ^ prev_climb['hold_set']) <= DEDUP_N:
                    is_dup = True
                    break
            
            if is_dup:
                continue

            accepted.append({
                'uuid': other['uuid'],
                'score': round(top_scores[i, j].item(), 6),
                'is_mirrored': bool(top_mirrored[i, j].item()),
            })

        canonical_results[query['uuid']] = accepted

    # 6. Expand to ALL app UUIDs via alias map
    #    Duplicate-frameset UUIDs point to the same result list.
    #    Ungraded UUIDs without a frameset alias are already in canonical_results
    #    (they were loaded as canonical entries themselves).
    final_results = {}
    for app_uuid, canonical_uuid in alias_map.items():
        if canonical_uuid in canonical_results:
            final_results[app_uuid] = canonical_results[canonical_uuid]

    # 7. Save
    print(f"Saving {len(final_results)} UUID entries to {OUTPUT_PATH}...")
    with open(OUTPUT_PATH, 'w') as f:
        json.dump(final_results, f)

    # 8. Stats
    lengths = [len(v) for v in final_results.values()]
    covered = len(final_results)
    print(f"Done. Coverage: {covered} UUIDs | Avg top-K: {sum(lengths)/max(len(lengths),1):.1f} / {TOP_K}")
    under = sum(1 for l in lengths if l < TOP_K)
    if under:
        print(f"  {under} climbs have fewer than {TOP_K} neighbours after dedup.")


if __name__ == "__main__":
    run()
