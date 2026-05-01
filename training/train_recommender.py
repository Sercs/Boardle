import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import Dataset, DataLoader
import sqlite3, re, random, os, math
import matplotlib.pyplot as plt
from tqdm import tqdm

# --- HYPERPARAMETERS ---
EMBED_DIM = 128
NHEAD = 4
NUM_LAYERS = 4
MAX_TOKENS = 32
VOCAB_SIZE = 1500
NUM_ROLES = 5       # 0:start, 1:mid, 2:finish, 3:foot, 4:distractor
NUM_GRADES = 24     # difficulty_average range ~10-38, 24 bins ≈ 1.2 per bin
NUM_ANGLES = 14     # 0,5,10,15..65 → 14 distinct bins (angle // 5)
PROJ_DIM = 128

# Special IDs (hold ID space)
MASK_ID  = VOCAB_SIZE
START_ID = VOCAB_SIZE + 1
CLS_ID   = VOCAB_SIZE + 2
PAD_ID   = VOCAB_SIZE + 3
NUM_SPECIAL = 4
HOLD_VOCAB = VOCAB_SIZE + NUM_SPECIAL  # 1504

MASK_ROLE = NUM_ROLES  # index 5
ROLE_VOCAB = NUM_ROLES + 1  # 6

# Joint token space (for output targets)
JOINT_VOCAB = VOCAB_SIZE * NUM_ROLES  # 7500

# Training
AUGMENT_FACTOR = 4
DISTRACTOR_COUNT = 3
UL_ALPHA = 1.0
AUTOMASK_RATIO = 0.5
K_STEPS = 3
CD_TAU = 0.7
DELAY_PROB = 0.3
MAX_DELAY = 3
MODALITY_ZERO_PROB = 0.5
GRADE_DROPOUT_PROB = 0.3

# Loss weights
W_COORD = 2.0
W_GRADE = 0.1
W_ANGLE = 0.05
W_PROX  = 0.05
W_MIRROR = 0.5


# ======================== SPATIAL ENCODING ========================

class SymmetricCoordEncoder(nn.Module):
    """Symmetric & Piecewise-Linear features for 'Fuzzy' Vibe learning."""
    def __init__(self):
        super().__init__()
        # Features: [abs(rx), ry, sgn(rx), rx^2, ry^2, rx*ry]
        self.out_dim = 6

    def forward(self, coords):
        # coords: [..., 2] relative (rx, ry)
        rx = coords[..., 0:1]
        ry = coords[..., 1:2]
        
        return torch.cat([
            rx.abs(),           # Symmetry-invariant shape
            ry,                 # Height
            torch.sign(rx),     # Side indicator (separable)
            rx**2,              # Smooth non-linearity
            ry**2,
            rx * ry             # Spatial interaction
        ], dim=-1)

# ======================== UTILS ========================
        """coords: [B, S, 2] raw (rel_x, rel_y). Returns [B, S, 3*F]."""
        rx = coords[..., 0:1]  # [B, S, 1]
        ry = coords[..., 1:2]
        f = self.freqs  # [F]
        x_cos = torch.cos(rx * f)           # [B, S, F] — symmetric!
        y_sin = torch.sin(ry * f)           # [B, S, F]
        y_cos = torch.cos(ry * f)           # [B, S, F]
        return torch.cat([x_cos, y_sin, y_cos], dim=-1)


# ======================== DATASET ========================

class RecommenderDataset(Dataset):
    def __init__(self, db_path, layout_id=11, mode='train', climbs_subset=None):
        self.db = sqlite3.connect(db_path)
        self.mode = mode
        self.role_map = {1:0, 5:0, 2:1, 6:1, 3:2, 7:2, 4:3, 8:3}

        cursor = self.db.cursor()
        # Hold coordinate cache
        cursor.execute("SELECT p.id, h.x, h.y FROM placements p JOIN holes h ON p.hole_id = h.id")
        self.cache = {}
        for pid, x, y in cursor.fetchall():
            self.cache[pid] = {'x': x / 88.0, 'y': y / 152.0}

        # Mirror map
        cursor.execute("""
            SELECT p1.id, p2.id FROM placements p1
            JOIN holes h1 ON p1.hole_id = h1.id
            JOIN holes h2 ON h1.mirrored_hole_id = h2.id
            JOIN placements p2 ON p2.hole_id = h2.id
        """)
        self.mirror_map = dict(cursor.fetchall())

        if climbs_subset is not None:
            self.climbs = climbs_subset
        else:
            self.climbs = []
            self.load_data(layout_id)
        print(f"RecommenderDataset [{mode}]: {len(self.climbs)} climbs, {len(self.cache)} holds")

    def load_data(self, layout_id):
        """Load graded climbs only (INNER JOIN climb_stats)."""
        cursor = self.db.cursor()
        cursor.execute("""
            SELECT c.uuid, c.frames, COALESCE(s.benchmark_difficulty, s.difficulty_average) as difficulty, COALESCE(c.angle, s.angle, 40) as angle
            FROM climbs c
            INNER JOIN (
                SELECT climb_uuid, difficulty_average, benchmark_difficulty, angle,
                       ROW_NUMBER() OVER (PARTITION BY climb_uuid ORDER BY ascensionist_count DESC) as rn
                FROM climb_stats
            ) s ON c.uuid = s.climb_uuid AND s.rn = 1
            WHERE c.layout_id = ? AND c.is_draft = 0 AND c.is_listed = 1
            GROUP BY c.frames
        """, (layout_id,))
        p_regex = re.compile(r'p(\d+)r(\d+)')
        for uuid, frames, difficulty, angle in cursor.fetchall():
            if difficulty is None: difficulty = 15.0
            if angle is None: angle = 40.0
            holds = []
            for p_id, r_id in p_regex.findall(frames):
                p_id = int(p_id)
                if p_id in self.cache:
                    holds.append({'id': p_id, 'role': self.role_map.get(int(r_id), 1)})
            if holds:
                grade_bin = max(0, min(NUM_GRADES - 1, int((difficulty - 10) / 2)))
                angle_bin = max(0, min(NUM_ANGLES - 1, int(angle / 5)))
                self.climbs.append({'uuid': uuid, 'holds': holds,
                                    'grade_bin': grade_bin, 'angle_bin': angle_bin})

    def load_ungraded(self, layout_id):
        """Load ungraded climbs (no climb_stats entry). Fallback to 40 if angle NULL."""
        cursor = self.db.cursor()
        cursor.execute("""
            SELECT c.uuid, c.frames, c.angle
            FROM climbs c
            LEFT JOIN climb_stats s ON c.uuid = s.climb_uuid
            WHERE c.layout_id = ? AND c.is_draft = 0 AND c.is_listed = 1
              AND s.climb_uuid IS NULL
            GROUP BY c.frames
        """, (layout_id,))
        p_regex = re.compile(r'p(\d+)r(\d+)')
        for uuid, frames, angle in cursor.fetchall():
            if angle is None: angle = 40.0
            holds = []
            for p_id, r_id in p_regex.findall(frames):
                p_id = int(p_id)
                if p_id in self.cache:
                    holds.append({'id': p_id, 'role': self.role_map.get(int(r_id), 1)})
            if holds:
                angle_bin = max(0, min(NUM_ANGLES - 1, int(angle / 5)))
                # grade_bin = NUM_GRADES → the MASK slot in grade_emb
                self.climbs.append({'uuid': uuid, 'holds': holds,
                                    'grade_bin': NUM_GRADES, 'angle_bin': angle_bin})

    def __len__(self): return len(self.climbs)
    def __getitem__(self, idx): return self.climbs[idx]

    def collate(self, batch):
        return recommender_collate(batch, self.cache, self.mirror_map, self.mode)


def recommender_collate(batch, cache, mirror_map, mode):
    board_ids = list(cache.keys())
    all_in_ids, all_in_roles, all_coords = [], [], []
    all_set_targets, all_route_masks = [], []
    all_target_coords = []
    all_grade, all_true_grade, all_angle = [], [], []
    all_origins = []
    all_uuids = []
    all_mirrored = []

    for climb in batch:
        holds_orig = [dict(h) for h in climb['holds']]

        # Lookup coords
        for h in holds_orig:
            c = cache.get(h['id'], {'x': 0.5, 'y': 0.5})
            h['x'], h['y'] = c['x'], c['y']

        cl_ids = {h['id'] for h in holds_orig}
        poss_dist = list(set(board_ids) - cl_ids)

        for _ in range(AUGMENT_FACTOR):
            holds = [dict(h) for h in holds_orig]

            # --- Mirror augmentation (50%) ---
            is_mirror = False
            if mode == 'train' and random.random() < 0.5:
                is_mirror = True
                for h in holds:
                    new_id = mirror_map.get(h['id'], h['id'])
                    mc = cache.get(new_id, {'x': h['x'], 'y': h['y']})
                    h['id'] = new_id
                    h['x'], h['y'] = mc['x'], mc['y']

            # --- Start-midpoint origin ---
            starts = [h for h in holds if h['role'] == 0]
            if starts:
                ox = sum(h['x'] for h in starts) / len(starts)
                oy = sum(h['y'] for h in starts) / len(starts)
            else:
                ox = sum(h['x'] for h in holds) / len(holds)
                oy = sum(h['y'] for h in holds) / len(holds)

            # --- Origin Jitter (Translation Augmentation) ---
            # By shifting the start-midpoint origin slightly, we force the model 
            # to be invariant to small translations on the board.
            if mode == 'train':
                ox += random.uniform(-0.05, 0.05)
                oy += random.uniform(-0.05, 0.05)

            for h in holds:
                h['rx'] = h['x'] - ox
                h['ry'] = h['y'] - oy

            # --- Jitter (training) ---
            if mode == 'train':
                for h in holds:
                    h['rx'] += random.uniform(-0.01, 0.01)
                    h['ry'] += random.uniform(-0.01, 0.01)

            # --- Distractors ---
            dist_ids = random.sample(poss_dist, min(DISTRACTOR_COUNT, len(poss_dist)))
            for d_id in dist_ids:
                dc = cache[d_id]
                holds.append({'id': d_id, 'role': 4,
                              'rx': dc['x'] - ox, 'ry': dc['y'] - oy,
                              'x': dc['x'], 'y': dc['y']})

            # --- Shuffle ---
            if mode == 'train':
                random.shuffle(holds)

            # --- Build sequence: [START, holds..., CLS, PAD...] ---
            # All joint IDs for the TRUE route (no distractors)
            route_joint = set()
            for h in holds:
                if h['role'] != 4:
                    route_joint.add(h['id'] * NUM_ROLES + h['role'])

            in_ids = [START_ID]
            in_roles = [MASK_ROLE]
            in_coords = [[0.0, 0.0]]
            target_coords = [[0.0, 0.0]]  # START has no coord target

            revealed = set()
            set_tgt = torch.zeros(MAX_TOKENS, JOINT_VOCAB)

            # --- Modality noise (training) ---
            noise_mask_id = set()
            noise_mask_coord = set()
            noise_mask_role = set()
            if mode == 'train':
                for pos_i, h in enumerate(holds):
                    # Start-Hold ID Ablation: 100% masking to force pure spatial/vibe learning
                    id_prob = 1.0 if h['role'] == 0 else MODALITY_ZERO_PROB
                    
                    # --- Symmetry Augmentation (Identity Shuffling) ---
                    # 10% of the time, we swap a hold with its physical mirror hold
                    # to break absolute hold-fixation in the identity path.
                    if random.random() < 0.1:
                        h['id'] = mirror_map.get(h['id'], h['id'])

                    if random.random() < id_prob:
                        noise_mask_id.add(pos_i)
                    
                    # General masking for other attributes
                    if random.random() < MODALITY_ZERO_PROB:
                        if random.random() < 0.5: noise_mask_coord.add(pos_i)
                        if random.random() < 0.5: noise_mask_role.add(pos_i)

            for i, h in enumerate(holds):
                if len(in_ids) >= MAX_TOKENS - 1:  # Leave room for CLS
                    break
                pos = len(in_ids)
                jid = h['id'] * NUM_ROLES + h['role']

                # Input (potentially masked)
                inp_id = MASK_ID if i in noise_mask_id else h['id']
                inp_role = MASK_ROLE if i in noise_mask_role else h['role']
                inp_coord = [0.0, 0.0] if i in noise_mask_coord else [h['rx'], h['ry']]

                in_ids.append(inp_id)
                in_roles.append(inp_role)
                in_coords.append(inp_coord)
                target_coords.append([h['rx'], h['ry']])

                # Set completion target: remaining route holds not yet revealed
                if h['role'] != 4:
                    revealed.add(jid)
                remaining = route_joint - revealed
                for rid in remaining:
                    if rid < JOINT_VOCAB:
                        set_tgt[pos, rid] = 1.0

            # Append CLS
            cls_pos = len(in_ids)
            in_ids.append(CLS_ID)
            in_roles.append(MASK_ROLE)
            in_coords.append([0.0, 0.0])
            target_coords.append([0.0, 0.0])

            # Pad
            curr = len(in_ids)
            if curr < MAX_TOKENS:
                pad_n = MAX_TOKENS - curr
                in_ids += [PAD_ID] * pad_n
                in_roles += [MASK_ROLE] * pad_n
                in_coords += [[0.0, 0.0]] * pad_n
                target_coords += [[0.0, 0.0]] * pad_n

            # Truncate
            in_ids = in_ids[:MAX_TOKENS]
            in_roles = in_roles[:MAX_TOKENS]
            in_coords = in_coords[:MAX_TOKENS]
            target_coords = target_coords[:MAX_TOKENS]

            # Route mask (binary over joint vocab)
            r_mask = torch.zeros(JOINT_VOCAB)
            for jid in route_joint:
                if jid < JOINT_VOCAB: r_mask[jid] = 1.0

            all_in_ids.append(torch.tensor(in_ids, dtype=torch.long))
            all_in_roles.append(torch.tensor(in_roles, dtype=torch.long))
            all_coords.append(torch.tensor(in_coords, dtype=torch.float32))
            all_target_coords.append(torch.tensor(target_coords, dtype=torch.float32))
            all_set_targets.append(set_tgt)
            all_route_masks.append(r_mask)
            # --- Grade Dropout & Jitter ---
            true_g = climb['grade_bin']
            in_g = true_g
            if mode == 'train':
                # Jitter: blur the grade boundary by +/- 1-2 bins
                if random.random() < 0.3:
                    in_g = max(0, min(NUM_GRADES - 1, in_g + random.randint(-2, 2)))
                # Dropout: force structure-only learning
                if random.random() < GRADE_DROPOUT_PROB:
                    in_g = NUM_GRADES 

            all_grade.append(in_g)
            all_true_grade.append(true_g)
            all_angle.append(climb['angle_bin'])
            all_origins.append(torch.tensor([ox, oy], dtype=torch.float32))
            all_uuids.append(climb['uuid'])
            all_mirrored.append(is_mirror)

    return {
        'in_ids': torch.stack(all_in_ids),
        'in_roles': torch.stack(all_in_roles),
        'coords': torch.stack(all_coords),
        'target_coords': torch.stack(all_target_coords),
        'set_targets': torch.stack(all_set_targets),
        'route_mask': torch.stack(all_route_masks),
        'grade': torch.tensor(all_grade, dtype=torch.long),
        'true_grade': torch.tensor(all_true_grade, dtype=torch.long),
        'angle': torch.tensor(all_angle, dtype=torch.long),
        'origins': torch.stack(all_origins),
        'uuids': all_uuids,
        'is_mirrored': torch.tensor(all_mirrored, dtype=torch.bool),
    }


# ======================== MODEL ========================

class TransformerBlock(nn.Module):
    def __init__(self, dim, nhead):
        super().__init__()
        self.attn = nn.MultiheadAttention(dim, nhead, batch_first=True)
        self.ln1 = nn.LayerNorm(dim)
        self.ln2 = nn.LayerNorm(dim)
        self.mlp = nn.Sequential(nn.Linear(dim, 4*dim), nn.GELU(), nn.Linear(4*dim, dim))

    def forward(self, x, mask):
        a, _ = self.attn(x, x, x, attn_mask=mask, need_weights=False)
        x = self.ln1(x + a)
        x = self.ln2(x + self.mlp(x))
        return x


class GenerativeRecommender(nn.Module):
    def __init__(self, hole_cache):
        super().__init__()
        self.rank = 8  # Bilinear rank

        # Board Coords [1500, 2]
        board_coords = torch.zeros(VOCAB_SIZE, 2)
        for pid, c in hole_cache.items():
            if pid < VOCAB_SIZE:
                if isinstance(c, dict):
                    board_coords[pid] = torch.tensor([c['x'], c['y']])
                else: # Assume tuple/list
                    board_coords[pid] = torch.tensor([c[0], c[1]])
        self.register_buffer('board_coords', board_coords)

        # Input embeddings
        self.id_emb    = nn.Embedding(HOLD_VOCAB, EMBED_DIM)
        self.role_emb  = nn.Embedding(ROLE_VOCAB, EMBED_DIM)
        self.grade_emb = nn.Embedding(NUM_GRADES + 1, EMBED_DIM)
        self.angle_emb = nn.Embedding(NUM_ANGLES + 1, EMBED_DIM)

        # Transformer backbone
        self.blocks = nn.ModuleList([TransformerBlock(EMBED_DIM, NHEAD) for _ in range(NUM_LAYERS)])

        # --- Bilinear Spatial-Identity Head ---
        # 1. Identity components
        self.hold_id_factors = nn.Parameter(torch.randn(VOCAB_SIZE, self.rank))
        self.role_id_factors = nn.Parameter(torch.randn(NUM_ROLES, self.rank))
        
        # 2. Coordinate Encoder
        self.coord_encoder = SymmetricCoordEncoder() 
        self.coord_proj    = nn.Linear(self.coord_encoder.out_dim, EMBED_DIM)
        self.spatial_proj  = nn.Linear(self.coord_encoder.out_dim, self.rank)
        
        # 3. Transformer Output Projections (The "Queries")
        self.q_hold_id = nn.Linear(EMBED_DIM, self.rank)
        self.q_spatial = nn.Linear(EMBED_DIM, self.rank)
        self.q_role    = nn.Linear(EMBED_DIM, NUM_ROLES * self.rank)
        
        # 4. Role Gating: Learned importance of Identity vs Space per Role
        # [NUM_ROLES, 1]
        self.role_id_alpha = nn.Parameter(torch.ones(NUM_ROLES, 1))
        self.role_sp_alpha = nn.Parameter(torch.ones(NUM_ROLES, 1))
        
        # Other heads
        self.head_coord = nn.Linear(EMBED_DIM, 2)
        self.head_grade = nn.Linear(EMBED_DIM, NUM_GRADES)
        self.head_angle = nn.Linear(EMBED_DIM, NUM_ANGLES)

        # Embedding projection
        self.cls_proj  = nn.Sequential(nn.Linear(EMBED_DIM, EMBED_DIM), nn.ReLU(), nn.Linear(EMBED_DIM, PROJ_DIM))
        self.pool_proj = nn.Sequential(nn.Linear(EMBED_DIM, EMBED_DIM), nn.ReLU(), nn.Linear(EMBED_DIM, PROJ_DIM))

    def forward(self, in_ids, in_roles, coords_2d, grade, angle, origins, causal_mask):
        B, S = in_ids.shape
        device = in_ids.device

        sp_feat = self.coord_encoder(coords_2d) # [B, S, 6]
        vibe = self.grade_emb(grade) + self.angle_emb(angle)  # [B, E]

        x = (self.id_emb(in_ids) + self.role_emb(in_roles)
             + self.coord_proj(sp_feat) + vibe.unsqueeze(1))

        for block in self.blocks:
            x = block(x, causal_mask)

        # --- 1. Bilinear Joint Generation ---
        # Predicted queries from transformer
        qh = self.q_hold_id(x)   # [B, S, R]
        qs = self.q_spatial(x)   # [B, S, R]
        qr = self.q_role(x).view(B, S, NUM_ROLES, self.rank) # [B, S, NUM_ROLES, R]

        # Compute board-wide relative coordinates [B, 1500, 2]
        rel_board = self.board_coords.unsqueeze(0) - origins.unsqueeze(1) 
        board_sp = self.coord_encoder(rel_board)  # Symmetric-Polynomial features
        sp_factors = self.spatial_proj(board_sp) # [B, 1500, R]

        # Composite Hold Latents: Identity + Spatial
        # Each is modulated by a role-specific "importance" factor
        # H[b, s, v, r] = alpha_id[r] * (qh[b,s] * ID[v]) + alpha_sp[r] * (qs[b,s] * SP[v])
        
        id_f = self.hold_id_factors.unsqueeze(0).unsqueeze(0) # [1, 1, 1500, R]
        if self.training and random.random() < 0.3:
            id_f = torch.zeros_like(id_f)

        # Broadcast alphas to [NUM_ROLES, R] for the bilinear interaction
        ai = self.role_id_alpha.sigmoid() # [5, 1]
        as_ = self.role_sp_alpha.sigmoid() # [5, 1]
        
        # We integrate the gating into the bilinear paths
        # hold_latents_id: [B, S, 1500, R]
        h_id = qh.unsqueeze(2) * id_f
        # hold_latents_sp: [B, S, 1500, R]
        h_sp = qs.unsqueeze(2) * sp_factors.unsqueeze(1)
        
        # role_latents: [B, S, 5, R]
        r_lat = qr * self.role_id_factors.unsqueeze(0).unsqueeze(0)
        
        # Joint: Combine paths with role-gated weights
        # joint_id[b,s,v,r] = h_id[b,s,v] * r_lat[b,s,r] * ai[r]
        # joint_sp[b,s,v,r] = h_sp[b,s,v] * r_lat[b,s,r] * as[r]
        
        logits_id = torch.einsum('bsvr,bsjr,jr->bsvj', h_id, r_lat, ai)
        logits_sp = torch.einsum('bsvr,bsjr,jr->bsvj', h_sp, r_lat, as_)
        
        joint = (logits_id + logits_sp).reshape(B, S, JOINT_VOCAB)
        
        coord_preds = self.head_coord(x)

        # --- Embedding: CLS + Mean-pool ---
        # Find CLS position (last non-PAD token)
        is_pad = (in_ids == PAD_ID)
        is_hold = ~is_pad & (in_ids != START_ID) & (in_ids != CLS_ID)

        # CLS hidden state: find CLS token position
        is_cls = (in_ids == CLS_ID)
        # Use sum trick: multiply and sum to extract CLS hidden
        cls_mask = is_cls.unsqueeze(-1).float()  # [B, S, 1]
        h_cls = (x * cls_mask).sum(dim=1)        # [B, E]

        # Mean-pool over hold positions (not START, CLS, PAD)
        hold_mask = is_hold.unsqueeze(-1).float()  # [B, S, 1]
        h_pool = (x * hold_mask).sum(dim=1) / (hold_mask.sum(dim=1) + 1e-6)  # [B, E]

        proj = self.cls_proj(h_cls) + self.pool_proj(h_pool)  # [B, PROJ_DIM]

        return {
            'joint_logits': joint,
            'coord_preds': coord_preds,
            'grade_logits': self.head_grade(h_pool),
            'angle_logits': self.head_angle(h_pool),
            'proj': proj,
            'latent': h_pool,
        }


# ======================== DELAYED CAUSAL MASK ========================

def build_delayed_causal_mask(seq_len, training=True, device='cpu'):
    """Causal mask with random attention delays during training."""
    mask = torch.triu(torch.ones(seq_len, seq_len, device=device) * float('-inf'), diagonal=1)
    if training:
        for col in range(1, seq_len - 1):  # Never delay CLS
            if random.random() < DELAY_PROB:
                d = random.randint(1, MAX_DELAY)
                for row in range(col + 1, min(col + d + 1, seq_len)):
                    mask[row, col] = float('-inf')
    return mask


# ======================== TRAINING ========================

def train_recommender(model, train_ds, test_ds, epochs=100):
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model.to(device)
    train_loader = DataLoader(train_ds, batch_size=64, shuffle=True, collate_fn=train_ds.collate)
    test_loader  = DataLoader(test_ds, batch_size=64, shuffle=False, collate_fn=test_ds.collate)
    optimizer = torch.optim.AdamW(model.parameters(), lr=3e-4)
    best_val = float('inf')
    history = {'train': [], 'val': []}

    # Coordinate lookup for automasking
    pid_coords = torch.zeros((VOCAB_SIZE + 10, 2), device=device)
    for pid, c in train_ds.cache.items():
        if pid < VOCAB_SIZE + 10:
            pid_coords[pid] = torch.tensor([c['x'], c['y']], device=device)

    for epoch in range(epochs):
        model.train()
        t_loss = 0
        pbar = tqdm(train_loader, desc=f"Epoch {epoch+1}")
        for batch in pbar:
            optimizer.zero_grad()
            in_ids = batch['in_ids'].to(device)
            in_roles = batch['in_roles'].to(device)
            coords = batch['coords'].to(device)
            set_tgt = batch['set_targets'].to(device)
            route_mask = batch['route_mask'].to(device)
            tgt_coords = batch['target_coords'].to(device)
            grade = batch['grade'].to(device)
            true_grade = batch['true_grade'].to(device)
            angle = batch['angle'].to(device)
            origins = batch['origins'].to(device)

            causal_mask = build_delayed_causal_mask(MAX_TOKENS, training=True, device=device)
            out = model(in_ids, in_roles, coords, grade, angle, origins, causal_mask)

            # --- 1. MLE SET COMPLETION ---
            logits = out['joint_logits']
            # Mask out already-seen tokens
            seen_onehot = torch.zeros_like(logits)
            # Map in_ids back to joint space: need original joint tokens
            # We use route_mask as the valid set, and cumulative reveal
            probs = F.softmax(logits, dim=-1)
            p_correct = (probs * set_tgt[:, :, :JOINT_VOCAB]).sum(-1)
            has_target = (set_tgt.sum(-1) > 0).float()
            l_mle = (-torch.log(p_correct.clamp(min=1e-10)) * has_target).sum() / (has_target.sum() + 1e-6)

            # --- 2. UNLIKELIHOOD ---
            all_probs = F.softmax(logits, dim=-1)
            not_in_route = (1.0 - route_mask).unsqueeze(1)
            hall_probs = all_probs * not_in_route[:, :, :JOINT_VOCAB]
            top_h, _ = torch.topk(hall_probs, k=5, dim=-1)
            l_ul = -torch.log(torch.clamp(1.0 - top_h, min=1e-10)).mean()

            # --- 3. COORDINATE REGRESSION ---
            # Only on hold positions (not START, CLS, PAD)
            is_hold = ((in_ids != PAD_ID) & (in_ids != START_ID) & (in_ids != CLS_ID)).float()
            coord_mask = is_hold.unsqueeze(-1)
            l_coord = F.mse_loss(out['coord_preds'] * coord_mask, tgt_coords * coord_mask)

            # --- 4. GRADE & ANGLE CLASSIFICATION ---
            # Map NUM_GRADES (24) to -100 (PyTorch default ignore_index)
            # Some CUDA kernels crash if ignore_index >= n_classes
            target_grade = true_grade.clone()
            target_grade[target_grade == NUM_GRADES] = -100
            l_grade = F.cross_entropy(out['grade_logits'], target_grade, ignore_index=-100)
            
            # Safety clamp for angle
            target_angle = angle.clamp(0, NUM_ANGLES - 1)
            l_angle = F.cross_entropy(out['angle_logits'], target_angle)

            # --- 5. GRADE PROXIMITY PENALTY (Hinge / Sliding Window) ---
            proj_norm = F.normalize(out['proj'], dim=1)
            sim_matrix = torch.matmul(proj_norm, proj_norm.T)
            # Only compute proximity for samples that HAVE a grade (0-23)
            valid_mask = (true_grade < NUM_GRADES).float()
            # Safety clamp before float conversion
            safe_grade = true_grade.clamp(0, NUM_GRADES - 1).float()
            grade_diff = torch.abs(safe_grade.unsqueeze(1) - safe_grade.unsqueeze(0))
            
            # Hinge Loss: grade difference is "free" if within 3 bins (~4 V-grades)
            # This encourages vibe overlap across adjacent grades.
            hinge_diff = F.relu(grade_diff - 3.0)
            
            # Mask out invalid pairs (where either sample is ungraded)
            valid_pairs = valid_mask.unsqueeze(1) * valid_mask.unsqueeze(0)
            l_prox = (F.relu(sim_matrix) * hinge_diff * valid_pairs).sum() / (valid_pairs.sum() + 1e-6)

            # --- 6. MIRROR CONSISTENCY (InfoNCE) ---
            # Instead of MSE, we use a contrastive loss to push mirrored pairs
            # together and push all other climbs in the batch apart.
            l_mirror = torch.tensor(0.0, device=device)
            uuids = batch['uuids']
            is_m = batch['is_mirrored'].to(device)
            
            # Find mirror pairs
            uuid_to_idx = {}
            for idx, u in enumerate(uuids):
                if u not in uuid_to_idx: uuid_to_idx[u] = []
                uuid_to_idx[u].append(idx)
            
            anchor_idx, positive_idx = [], []
            for u, indices in uuid_to_idx.items():
                if len(indices) > 1:
                    origs = [i for i in indices if not is_m[i]]
                    mirrs = [i for i in indices if is_m[i]]
                    for o in origs:
                        for m in mirrs:
                            anchor_idx.append(o)
                            positive_idx.append(m)
            
            if anchor_idx:
                # InfoNCE: cosine similarity matrix [B_sub, B_sub]
                z_a = proj_norm[anchor_idx]
                z_p = proj_norm[positive_idx]
                logits = torch.matmul(z_a, z_p.T) / 0.07 # Temperature 0.07
                labels = torch.arange(len(anchor_idx), device=device)
                l_mirror = F.cross_entropy(logits, labels)
            
            # --- TOTAL ---
            loss = (l_mle
                    + UL_ALPHA * l_ul
                    + W_COORD * l_coord
                    + W_GRADE * l_grade
                    + W_ANGLE * l_angle
                    + W_PROX * l_prox
                    + W_MIRROR * l_mirror)

            loss.backward()
            optimizer.step()
            t_loss += l_mle.item()
            pbar.set_postfix({'mle': l_mle.item(), 'ul': l_ul.item(),
                              'grd': l_grade.item(), 'prx': l_prox.item()})

        # --- Validation ---
        model.eval()
        v_loss = 0
        val_mask = torch.triu(torch.ones(MAX_TOKENS, MAX_TOKENS, device=device) * float('-inf'), diagonal=1)
        with torch.no_grad():
            for batch in test_loader:
                in_ids   = batch['in_ids'].to(device)
                in_roles = batch['in_roles'].to(device)
                coords   = batch['coords'].to(device)
                set_tgt  = batch['set_targets'].to(device)
                grade    = batch['grade'].to(device)
                true_grade = batch['true_grade'].to(device)
                angle    = batch['angle'].to(device)
                origins  = batch['origins'].to(device)
                out = model(in_ids, in_roles, coords, grade, angle, origins, val_mask)
                probs = F.softmax(out['joint_logits'], dim=-1)
                pc = (probs * set_tgt[:, :, :JOINT_VOCAB]).sum(-1)
                hm = (set_tgt.sum(-1) > 0).float()
                # MLE only — grade/angle classification skipped for ungraded val set
                v_loss += ((-torch.log(pc.clamp(min=1e-10)) * hm).sum() / (hm.sum() + 1e-6)).item()

        avg_t = t_loss / len(train_loader)
        avg_v = v_loss / len(test_loader)
        history['train'].append(avg_t)
        history['val'].append(avg_v)
        print(f"Epoch {epoch+1}: Train MLE={avg_t:.4f} | Val MLE={avg_v:.4f}")

        if avg_v < best_val:
            best_val = avg_v
            torch.save(model.state_dict(), 'recommender_best.pth')
            print(f"--- BEST SAVED: {best_val:.4f} ---")
        torch.save(model.state_dict(), 'recommender_latest.pth')

    plt.figure(figsize=(8, 5))
    plt.plot(history['train'], label='Train MLE')
    plt.plot(history['val'], label='Val MLE')
    plt.title('Generative Recommender')
    plt.legend()
    plt.savefig('recommender_curves.png')


if __name__ == "__main__":
    db_path = 'public/tension.sqlite3'

    # Training set: all graded climbs
    train_ds = RecommenderDataset(db_path, mode='train')

    # Validation set: ungraded climbs (natural held-out, zero contamination)
    val_ds = RecommenderDataset(db_path, mode='eval', climbs_subset=[])
    val_ds.cache      = train_ds.cache
    val_ds.mirror_map = train_ds.mirror_map
    val_ds.load_ungraded(layout_id=11)
    print(f"Val set (ungraded): {len(val_ds.climbs)} climbs")

    train_recommender(GenerativeRecommender(train_ds.cache), train_ds, val_ds, epochs=50)
