import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import Dataset, DataLoader
import sqlite3
import re
import json
import random
import os
import matplotlib.pyplot as plt
from tqdm import tqdm

# --- HYPERPARAMETERS ---
EMBED_DIM = 128
NHEAD = 4
NUM_LAYERS = 6
MAX_TOKENS = 30  # Halved due to joint tokens
VOCAB_SIZE = 1500 # Hold IDs
NUM_ROLES = 5    # 0: Start, 1: Intermediate, 2: Finish, 3: Foot, 4: Distractor

# Joint Token Mapping: (pid * NUM_ROLES) + role
JOINT_VOCAB_SIZE = VOCAB_SIZE * NUM_ROLES
START_ID = JOINT_VOCAB_SIZE 
PAD_ID = JOINT_VOCAB_SIZE + 1

AUGMENT_FACTOR = 4 
UL_ALPHA = 1.2 # Slightly increased to handle harder negatives
DISTRACTOR_COUNT = 3 
AUTOMASK_RATIO = 0.5 
K_STEPS = 3       # CD-k depth
CD_TAU = 0.7      # Discovery temperature (lower = more adversarial)

class AbsoluteClimbDataset(Dataset):
    def __init__(self, db_path, layout_id=11, mode='train', climbs_subset=None):
        self.db = sqlite3.connect(db_path)
        self.mode = mode 
        self.role_map = {1:0, 5:0, 2:1, 6:1, 3:2, 7:2, 4:3, 8:3}
        if climbs_subset is not None: self.climbs = climbs_subset
        else:
            self.climbs = []
            self.load_data(layout_id)

    def load_data(self, layout_id):
        cursor = self.db.cursor()
        cursor.execute("SELECT c.uuid, c.frames FROM climbs c WHERE c.layout_id = ? AND c.is_draft = 0 AND c.is_listed = 1", (layout_id,))
        p_regex = re.compile(r'p(\d+)r(\d+)')
        for uuid, frames in cursor.fetchall():
            holds = []
            for p_id, r_id in p_regex.findall(frames):
                holds.append({'id': int(p_id), 'role': self.role_map.get(int(r_id), 1)})
            if holds: self.climbs.append({'holds': holds})

    def fetch_coords(self, holds):
        processed = []
        cursor = self.db.cursor()
        for h in holds:
            cursor.execute("SELECT h.x, h.y FROM placements p JOIN holes h ON p.hole_id = h.id WHERE p.id = ?", (h['id'],))
            pos = cursor.fetchone()
            if pos: processed.append({**h, 'x': pos[0]/88.0, 'y': pos[1]/152.0})
        return processed

    def __len__(self): return len(self.climbs)
    def __getitem__(self, idx): return self.climbs[idx]

def expansion_collate_fn_with_cache(batch, hole_cache):
    all_tokens, all_coords, all_targets, all_set_targets, all_route_masks = [], [], [], [], []
    board_ids = list(hole_cache.keys())
    for climb in batch:
        holds_orig = climb['holds']
        cl_ids = {h['id'] for h in holds_orig}
        # Joint tokens for the climb
        cl_joint_ids = {(h['id'] * NUM_ROLES) + h['role'] for h in holds_orig}
        
        poss_dist = list(set(board_ids) - cl_ids)
        for _ in range(AUGMENT_FACTOR):
            h_var = list(holds_orig)
            if len(h_var) > 5 and random.random() < 0.3: h_var = h_var[max(1, int(len(h_var)*0.15)):]
            distractor_ids = random.sample(poss_dist, DISTRACTOR_COUNT) if len(poss_dist) >= DISTRACTOR_COUNT else []
            
            tagged = [{'h': h, 'dist': False} for h in h_var]
            for d_id in distractor_ids:
                d_h = {'id': d_id, 'role': 4, **hole_cache[d_id]}
                tagged.append({'h': d_h, 'dist': True})
            random.shuffle(tagged)
            
            in_tokens, in_coords, targets = [START_ID], [[0.0, 0.0]], []
            for item in tagged:
                h, is_dist = item['h'], item['dist']
                joint_id = (h['id'] * NUM_ROLES) + h['role']
                in_tokens.append(joint_id)
                in_coords.append([h['x'], h['y']])
                targets.append(joint_id if not is_dist else PAD_ID)
            
            targets.append(PAD_ID)
            
            if len(in_tokens) > MAX_TOKENS: in_tokens, in_coords, targets = in_tokens[:MAX_TOKENS], in_coords[:MAX_TOKENS], targets[:MAX_TOKENS]
            
            set_t = torch.zeros(MAX_TOKENS, JOINT_VOCAB_SIZE + 10)
            r_mask = torch.zeros(JOINT_VOCAB_SIZE + 10)
            for jid in cl_joint_ids: 
                if jid < JOINT_VOCAB_SIZE: r_mask[jid] = 1.0
            
            rev = set()
            for i in range(len(in_tokens)):
                if in_tokens[i] < JOINT_VOCAB_SIZE: rev.add(in_tokens[i])
                rem = cl_joint_ids - rev
                for jid in rem:
                    if jid < JOINT_VOCAB_SIZE: set_t[i, jid] = 1.0
            
            if len(in_tokens) < MAX_TOKENS:
                pad = MAX_TOKENS - len(in_tokens)
                in_tokens += [PAD_ID]*pad; in_coords += [[0.0,0.0]]*pad
                targets += [PAD_ID]*(MAX_TOKENS-len(targets))
            
            all_tokens.append(torch.tensor(in_tokens)); all_coords.append(torch.tensor(in_coords, dtype=torch.float32))
            all_targets.append(torch.tensor(targets)); all_set_targets.append(set_t)
            all_route_masks.append(r_mask)
            
    return {'tokens': torch.stack(all_tokens), 'coords': torch.stack(all_coords), 'targets': torch.stack(all_targets), 'set_targets': torch.stack(all_set_targets), 'route_mask': torch.stack(all_route_masks)}

class TransformerBlock(nn.Module):
    def __init__(self, embed_dim, nhead):
        super().__init__()
        self.attn = nn.MultiheadAttention(embed_dim, nhead, batch_first=True)
        self.ln1 = nn.LayerNorm(embed_dim); self.ln2 = nn.LayerNorm(embed_dim)
        self.mlp = nn.Sequential(nn.Linear(embed_dim, 4*embed_dim), nn.GELU(), nn.Linear(4*embed_dim, embed_dim))
    def forward(self, x, mask):
        attn_out, _ = self.attn(x, x, x, attn_mask=mask, need_weights=False)
        x = self.ln1(x + attn_out); x = self.ln2(x + self.mlp(x))
        return x

RANK = 5 # Rank-5 Bilinear Interaction (Matches param count of original joint head)

class ClimbGenerator(nn.Module):
    def __init__(self):
        super().__init__()
        self.token_emb = nn.Embedding(JOINT_VOCAB_SIZE + 10, EMBED_DIM)
        self.pos_proj = nn.Linear(2, EMBED_DIM)
        self.blocks = nn.ModuleList([TransformerBlock(EMBED_DIM, NHEAD) for _ in range(NUM_LAYERS)])
        
        # Bilinear Factorization: 1500 holds x Rank + 5 roles x Rank
        self.hold_latents = nn.Linear(EMBED_DIM, VOCAB_SIZE * RANK)
        self.role_latents = nn.Linear(EMBED_DIM, NUM_ROLES * RANK)
        self.special_head = nn.Linear(EMBED_DIM, 10) # For START/PAD tokens
        
    def forward(self, tokens, coords, mask):
        B, S, _ = coords.shape
        x = self.token_emb(tokens) + self.pos_proj(coords)
        for block in self.blocks: x = block(x, mask)
        
        # Project into interaction space
        h_l = self.hold_latents(x).view(B, S, VOCAB_SIZE, RANK)
        r_l = self.role_latents(x).view(B, S, NUM_ROLES, RANK)
        
        # Bilinear Interaction: dot product over RANK dimension
        # Resulting shape: [B, S, 1500, 5]
        joint = torch.einsum('bsir,bsjr->bsij', h_l, r_l).reshape(B, S, JOINT_VOCAB_SIZE)
        specials = self.special_head(x) 
        
        return torch.cat([joint, specials], dim=-1)

def sample_fantasy_distractors(model, tokens, coords, mask, set_targets, pid_coords, k=K_STEPS, tau=CD_TAU):
    """
    Performs k-steps of stochastic discovery to find deep hallucinations.
    Uses the causal mask to discover fantasy sequences in parallel.
    """
    B, S = tokens.shape
    device = tokens.device
    V = JOINT_VOCAB_SIZE + 10
    
    curr_tokens = tokens.clone()
    curr_coords = coords.clone()
    
    for _ in range(k):
        logits = model(curr_tokens, curr_coords, mask)
        
        # 1. Mask out valid targets
        valid_mask = set_targets[:, :, :V] > 0
        neg_logits = logits.masked_fill(valid_mask, float('-inf'))
        
        # 2. Stochastic Sample from the hallucination manifold
        probs = F.softmax(neg_logits / tau, dim=-1)
        dist = torch.distributions.Categorical(probs)
        sampled_ids = dist.sample()
        
        # 3. Update context for the next step of the fantasy chain
        curr_tokens = sampled_ids
        pids = sampled_ids // NUM_ROLES
        curr_coords = pid_coords[pids.clamp(max=VOCAB_SIZE + 9)]
        
    return curr_tokens, curr_coords

def train_generator(model, train_ds, test_ds, hole_cache, epochs=5):
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model.to(device)
    train_loader = DataLoader(train_ds, batch_size=64, shuffle=True, collate_fn=train_ds.collate)
    test_loader = DataLoader(test_ds, batch_size=64, shuffle=False, collate_fn=test_ds.collate)
    optimizer = torch.optim.AdamW(model.parameters(), lr=3e-4)
    mask = torch.triu(torch.ones(MAX_TOKENS, MAX_TOKENS, device=device)*float('-inf'), diagonal=1)
    history = {'train_id': [], 'train_role': [], 'test_id': [], 'test_role': []}
    best_val = float('inf')

    # Pre-calculate coordinate tensor for all pids for fast lookup during automasking
    pid_coords = torch.zeros((VOCAB_SIZE + 10, 2), device=device)
    for pid, c in hole_cache.items():
        if pid < VOCAB_SIZE + 10:
            pid_coords[pid] = torch.tensor([c['x'], c['y']], device=device)

    for epoch in range(epochs):
        model.train()
        t_loss, t_ul = 0, 0
        pbar = tqdm(train_loader, desc=f"Epoch {epoch+1}")
        for batch in pbar:
            optimizer.zero_grad()
            tokens, coords = batch['tokens'].to(device), batch['coords'].to(device)
            targets, set_targets = batch['targets'].to(device), batch['set_targets'].to(device)
            route_mask = batch['route_mask'].to(device)
            
            # --- 0. CD-k AUTOMASKING (Fantasy Sequence Discovery) ---
            if AUTOMASK_RATIO > 0:
                model.eval()
                with torch.no_grad():
                    # Discover k-step deep hallucinations
                    fantasy_tokens, fantasy_coords = sample_fantasy_distractors(
                        model, tokens, coords, mask, set_targets, pid_coords
                    )
                    
                    # Find existing random distractors (Role 4) to be replaced
                    is_distractor = (tokens % NUM_ROLES == 4)
                    
                    # Replace a fraction of random distractors with "fantasy" distractors
                    mask_replace = (torch.rand(tokens.shape, device=device) < AUTOMASK_RATIO) & is_distractor
                    
                    if mask_replace.any():
                        # Force the fantasy tokens to adopt the Distractor Role (4) 
                        hard_pids = fantasy_tokens[mask_replace] // NUM_ROLES
                        hard_dist_tokens = (hard_pids * NUM_ROLES) + 4
                        tokens[mask_replace] = hard_dist_tokens
                        coords[mask_replace] = pid_coords[hard_pids.clamp(max=VOCAB_SIZE+9)]
                        
                        # Store for on-policy unlikelihood
                        batch['hard_neg_ids'] = fantasy_tokens
                    else:
                        batch['hard_neg_ids'] = None
                
                model.train()

            logits = model(tokens, coords, mask)
            
            # --- 1. JOINT LOSS (MLE Set Completion) ---
            m_logits = logits.clone()
            m_ones = torch.zeros_like(logits); m_ones.scatter_(-1, tokens.unsqueeze(-1).long().clamp(max=JOINT_VOCAB_SIZE), 1.0)
            seen = torch.cumsum(m_ones, dim=1); m_logits = m_logits.masked_fill(seen > 0, -1e9)
            probs = F.softmax(m_logits, dim=-1)
            p_correct = (probs * set_targets[:, :, :JOINT_VOCAB_SIZE + 10]).sum(-1)
            h_mask = (set_targets.sum(-1) > 0).float()
            l_mle = (-torch.log(p_correct.clamp(min=1e-10)) * h_mask).sum() / (h_mask.sum() + 1e-6)
            
            # --- 2. ON-POLICY UNLIKELIHOOD (Sequence-Level Penalization) ---
            all_probs = F.softmax(logits, dim=-1)
            # Use the sampled fantasy tokens from the discovery phase
            # If no discovery happened (e.g. ratio=0), fallback to standard top-k
            if batch.get('hard_neg_ids') is not None:
                h_ids = batch['hard_neg_ids'].to(device)
                h_probs = all_probs.gather(-1, h_ids.unsqueeze(-1).clamp(max=JOINT_VOCAB_SIZE)).squeeze(-1)
                l_ul = -torch.log(torch.clamp(1.0 - h_probs, min=1e-10)).mean()
            else:
                not_in_route = (1.0 - route_mask).unsqueeze(1) 
                hallucination_probs = all_probs * not_in_route[:, :, :JOINT_VOCAB_SIZE + 10]
                top_h_probs, _ = torch.topk(hallucination_probs, k=5, dim=-1)
                l_ul = -torch.log(torch.clamp(1.0 - top_h_probs, min=1e-10)).mean()

            loss = l_mle + UL_ALPHA * l_ul
            loss.backward(); optimizer.step()
            t_loss += l_mle.item(); t_ul += l_ul.item()
            pbar.set_postfix({'mle': l_mle.item(), 'ul': l_ul.item()})

        # Validation
        model.eval()
        v_id, v_role = 0, 0
        with torch.no_grad():
            for batch in test_loader:
                tokens, coords = batch['tokens'].to(device), batch['coords'].to(device)
                t, st = batch['targets'].to(device), batch['set_targets'].to(device)
                logits = model(tokens, coords, mask)
                probs = F.softmax(logits, dim=-1)
                pc = (probs * st[:, :, :JOINT_VOCAB_SIZE + 10]).sum(-1); hm = (st.sum(-1) > 0).float()
                v_id += ((-torch.log(pc.clamp(min=1e-10)) * hm).sum() / (hm.sum()+1e-6)).item()

        avg_v = v_id / len(test_loader)
        if avg_v < best_val:
            best_val = avg_v
            torch.save(model.state_dict(), 'climb_generator_best.pth')
            print(f"--- BEST SAVED: {best_val:.4f} ---")
        history['train_id'].append(t_loss/len(train_loader)); history['test_id'].append(v_id/len(test_loader))

    plt.subplot(1, 2, 1); plt.plot(history['train_id']); plt.plot(history['test_id']); plt.title('Joint Loss')
    plt.savefig('learning_curves.png')

def export_onnx():
    base_model = ClimbGenerator()
    if os.path.exists('climb_generator_best.pth'): base_model.load_state_dict(torch.load('climb_generator_best.pth', map_location='cpu'))
    base_model.eval()
    d_tok = torch.randint(0, JOINT_VOCAB_SIZE, (1, MAX_TOKENS))
    d_cor, d_msk = torch.randn(1, MAX_TOKENS, 2), torch.triu(torch.ones(MAX_TOKENS, MAX_TOKENS)*float('-inf'), diagonal=1)
    torch.onnx.export(base_model, (d_tok, d_cor, d_msk), "public/models/climb_generator.onnx", input_names=['tokens', 'coords', 'mask'], output_names=['logits'], opset_version=14)
    print("Exported to public/models/climb_generator.onnx")

class PreLoadedDataset(AbsoluteClimbDataset):
    def __init__(self, db_path, mode='train', climbs_subset=None):
        super().__init__(db_path, mode=mode, climbs_subset=climbs_subset)
        self.cache = {}
        cursor = self.db.cursor()
        cursor.execute("SELECT p.id, h.x, h.y FROM placements p JOIN holes h ON p.hole_id = h.id")
        for pid, x, y in cursor.fetchall(): self.cache[pid] = {'x': x/88.0, 'y': y/152.0}
        print(f"Pre-loading {len(self.climbs)} climbs...")
        for c in tqdm(self.climbs):
            for h in c['holds']: h.update(self.cache.get(h['id'], {'x':0.5, 'y':0.5}))
    def collate(self, batch): return expansion_collate_fn_with_cache(batch, self.cache)

if __name__ == "__main__":
    db_path = 'public/tension.sqlite3'
    ds = PreLoadedDataset(db_path)
    random.shuffle(ds.climbs); n_t = int(0.9 * len(ds.climbs))
    train_ds = PreLoadedDataset(db_path, mode='train', climbs_subset=ds.climbs[:n_t])
    test_ds = PreLoadedDataset(db_path, mode='eval', climbs_subset=ds.climbs[n_t:])
    train_generator(ClimbGenerator(), train_ds, test_ds, ds.cache, epochs=100); export_onnx()
