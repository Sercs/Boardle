import json
import os
import struct

BIN_PATH = 'public/similarities.bin'
JSON_MAP_PATH = 'public/climb_uuids.json'
SOURCE_JSON_PATH = 'public/topk_similarity.json'

def migrate():
    if not os.path.exists(SOURCE_JSON_PATH):
        print(f"Error: {SOURCE_JSON_PATH} not found.")
        return

    print(f"Loading {SOURCE_JSON_PATH}...")
    with open(SOURCE_JSON_PATH, 'r') as f:
        data = json.load(f)

    # 1. Collect all unique UUIDs and create stable mapping
    print("Generating UUID mapping...")
    all_uuids = set()
    for source_uuid, targets in data.items():
        all_uuids.add(source_uuid)
        for t in targets:
            all_uuids.add(t['uuid'])
    
    sorted_uuids = sorted(list(all_uuids))
    uuid_to_id = {uuid: i for i, uuid in enumerate(sorted_uuids)}
    num_climbs = len(sorted_uuids)

    # Save UUID map for the frontend
    print(f"Saving {JSON_MAP_PATH}...")
    with open(JSON_MAP_PATH, 'w') as f:
        json.dump(sorted_uuids, f)

    # 2. Prepare binary data
    # We'll store:
    # - uint32: num_climbs
    # - uint32[num_climbs + 1]: offset_table (index into target_ids and mirror_flags)
    # - uint16[]: target_ids
    # - uint8[]: mirror_flags
    
    print("Building binary structure...")
    offsets = [0] * (num_climbs + 1)
    target_ids = []
    mirror_flags = []
    
    current_offset = 0
    for i, uuid in enumerate(sorted_uuids):
        targets = data.get(uuid, [])
        offsets[i] = current_offset
        for t in targets:
            target_ids.append(uuid_to_id[t['uuid']])
            mirror_flags.append(1 if t.get('is_mirrored') else 0)
        current_offset += len(targets)
    offsets[num_climbs] = current_offset

    print(f"Writing {BIN_PATH}...")
    with open(BIN_PATH, 'wb') as f:
        # Write num_climbs
        f.write(struct.pack('<I', num_climbs))
        
        # Write offset table
        f.write(struct.pack(f'<{len(offsets)}I', *offsets))
        
        # Write target IDs (uint16)
        f.write(struct.pack(f'<{len(target_ids)}H', *target_ids))
        
        # Write mirror flags (uint8)
        f.write(struct.pack(f'<{len(mirror_flags)}B', *mirror_flags))

    print(f"Migration complete!")
    print(f"  Climbs: {num_climbs}")
    print(f"  Total relationships: {len(target_ids)}")
    print(f"  Binary size: {os.path.getsize(BIN_PATH) / 1024 / 1024:.2f} MB")
    print(f"  JSON map size: {os.path.getsize(JSON_MAP_PATH) / 1024 / 1024:.2f} MB")

if __name__ == "__main__":
    migrate()
