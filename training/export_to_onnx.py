import torch
import torch.nn as nn
from climb_transformer import ClimbRecommender, VOCAB_SIZE, NUM_ROLES, EMBED_DIM

def export():
    model = ClimbRecommender()
    # Load the latest checkpoint
    checkpoint_path = "climb_recommender.pth"

    try:
        model.load_state_dict(torch.load(checkpoint_path, map_location='cpu'), strict=False)
        print(f"Loaded weights from {checkpoint_path} (non-strict)")
    except Exception as e:

        print(f"Error loading checkpoint: {e}")
        return

    model.eval()

    # Create dummy inputs for a sequence of 5 holds
    batch_size = 1
    seq_len = 5
    
    dummy_hold_ids = torch.randint(0, VOCAB_SIZE, (batch_size, seq_len), dtype=torch.int32)
    dummy_role_ids = torch.randint(0, NUM_ROLES, (batch_size, seq_len), dtype=torch.int32)
    dummy_coords = torch.randn(batch_size, seq_len, 3)
    dummy_angle = torch.tensor([40.0])
    dummy_mask = torch.triu(torch.ones(seq_len, seq_len) * float('-inf'), diagonal=1)

    # Export the model
    onnx_path = "public/models/climb_recommender.onnx"
    
    class ONNXWrapper(nn.Module):
        def __init__(self, model):
            super().__init__()
            self.model = model
        def forward(self, h_ids, r_ids, coords, angle, mask):
            # Cast 32-bit from browser back to 64-bit for Embeddings
            h64 = h_ids.to(torch.int64)
            r64 = r_ids.to(torch.int64)
            out = self.model(h64, r64, coords, angle, mask)
            return out['id_logits'], out['role_logits'], out['coords'], out['grade_seq']

    wrapped_model = ONNXWrapper(model)
    wrapped_model.eval()
    
    print("Exporting model (Int32 Optimized)...")
    # Use legacy exporter for stability with dynamic axes
    try:
        torch.onnx.export(
            wrapped_model,
            (dummy_hold_ids, dummy_role_ids, dummy_coords, dummy_angle, dummy_mask),
            onnx_path,
            export_params=True,
            opset_version=14,
            do_constant_folding=True,
            input_names=['hold_ids', 'role_ids', 'coords', 'angle', 'mask'],
            output_names=['id_logits', 'role_logits', 'pred_coords', 'pred_grades'],
            dynamic_axes={
                'hold_ids': {1: 'sequence_length'},
                'role_ids': {1: 'sequence_length'},
                'coords': {1: 'sequence_length'},
                'mask': {0: 'sequence_length', 1: 'sequence_length'}
            },
            dynamo=False
        )

    except TypeError:
        # Fallback if dynamo=False is not a valid kwarg in this version
        torch.onnx.export(
            wrapped_model,
            (dummy_hold_ids, dummy_role_ids, dummy_coords, dummy_angle, dummy_mask),
            onnx_path,
            export_params=True,
            opset_version=14,
            do_constant_folding=True,
            input_names=['hold_ids', 'role_ids', 'coords', 'angle', 'mask'],
            output_names=['id_logits', 'role_logits', 'pred_coords', 'pred_grades'],
            dynamic_axes={
                'hold_ids': {1: 'sequence_length'},
                'role_ids': {1: 'sequence_length'},
                'coords': {1: 'sequence_length'},
                'mask': {0: 'sequence_length', 1: 'sequence_length'}
            }
        )








    print(f"Model exported to {onnx_path}")

if __name__ == "__main__":
    export()
