
importScripts('/sql-wasm.js');

let db;
let placements = [];

const DB_NAME = 'boardle-db';
const STORE_NAME = 'sqlite';
const IMAGE_STORE_NAME = 'images';
const DB_KEY = 'tension-db';

async function saveToIndexedDB(buffer) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
      if (!db.objectStoreNames.contains(IMAGE_STORE_NAME)) db.createObjectStore(IMAGE_STORE_NAME);
    };
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      store.put(buffer, DB_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    };
    request.onerror = () => reject(request.error);
  });
}

async function loadFromIndexedDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
      if (!db.objectStoreNames.contains(IMAGE_STORE_NAME)) db.createObjectStore(IMAGE_STORE_NAME);
    };
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const getRequest = store.get(DB_KEY);
      getRequest.onsuccess = () => resolve(getRequest.result);
      getRequest.onerror = () => reject(getRequest.error);
    };
    request.onerror = () => reject(request.error);
  });
}

self.onmessage = async function(e) {
  const { type, payload } = e.data;
  console.log('Worker received:', type);

  if (type === 'INIT' || type === 'READY') {
    try {
      let isLocal = !!db;

      if (type === 'INIT') {
        console.log('Worker initializing sql.js...');
        self.SQL_LIB = await initSqlJs({
          locateFile: file => `/${file}`
        });
        const SQL = self.SQL_LIB;

        // 1. Try loading from IndexedDB first
        let buffer = await loadFromIndexedDB();
        isLocal = !!buffer;
        
        if (buffer) {
          try {
            db = new SQL.Database(new Uint8Array(buffer));
            db.exec("SELECT 1");
            console.log('Loaded database from IndexedDB');
          } catch (e) {
            console.error('IndexedDB database is corrupted, clearing...', e);
            buffer = null;
            isLocal = false;
            const request = indexedDB.open(DB_NAME, 1);
            request.onsuccess = () => {
              request.result.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(DB_KEY);
            };
          }
        }

        if (!buffer) {
          console.log('No local DB found. Creating a blank database...');
          db = new SQL.Database();
          db.run(`
            CREATE TABLE shared_syncs (table_name TEXT PRIMARY KEY, last_synchronized_at TEXT);
            CREATE TABLE climbs (uuid TEXT PRIMARY KEY, name TEXT, setter_username TEXT, layout_id INTEGER, frames TEXT, created_at TEXT, is_listed INTEGER, is_draft INTEGER, angle INTEGER);
            CREATE TABLE climb_stats (climb_uuid TEXT, angle INTEGER, ascensionist_count INTEGER, difficulty_average REAL, quality_average REAL, benchmark_difficulty REAL, display_difficulty REAL, PRIMARY KEY(climb_uuid, angle));
            CREATE TABLE holes (id INTEGER PRIMARY KEY, x INTEGER, y INTEGER);
            CREATE TABLE placements (id INTEGER PRIMARY KEY, hole_id INTEGER, layout_id INTEGER, default_role_id INTEGER);
            CREATE TABLE leds (id INTEGER PRIMARY KEY, product_id INTEGER, placement_id INTEGER, led_color_id INTEGER, position INTEGER, product_size_id INTEGER, hole_id INTEGER);
            CREATE TABLE difficulty_grades (difficulty INTEGER PRIMARY KEY, boulder_name TEXT, is_listed INTEGER);
            CREATE TABLE product_sizes_layouts_sets (id INTEGER PRIMARY KEY, layout_id INTEGER, product_size_id INTEGER, image_filename TEXT);
            
            INSERT INTO shared_syncs (table_name, last_synchronized_at) VALUES 
              ('climbs', '1970-01-01 00:00:00.000000'),
              ('climb_stats', '1970-01-01 00:00:00.000000'),
              ('holes', '1970-01-01 00:00:00.000000'),
              ('placements', '1970-01-01 00:00:00.000000'),
              ('leds', '1970-01-01 00:00:00.000000'),
              ('difficulty_grades', '1970-01-01 00:00:00.000000'),
              ('product_sizes_layouts_sets', '1970-01-01 00:00:00.000000'),
              ('methods', '1970-01-01 00:00:00.000000'),
              ('angles', '1970-01-01 00:00:00.000000'),
              ('shared_syncs', '1970-01-01 00:00:00.000000');
          `);
        }

        // Schema Upgrades
        try {
          const climbInfo = db.exec("PRAGMA table_info(climbs)");
          if (!climbInfo[0].values.some(v => v[1] === 'is_listed')) {
            db.run("ALTER TABLE climbs ADD COLUMN is_listed INTEGER DEFAULT 1");
          }
          const ledInfo = db.exec("PRAGMA table_info(leds)");
          if (!ledInfo[0].values.some(v => v[1] === 'position')) {
            db.run("ALTER TABLE leds ADD COLUMN position INTEGER");
          }
          const statsInfo = db.exec("PRAGMA table_info(climb_stats)");
          if (!statsInfo[0].values.some(v => v[1] === 'display_difficulty')) {
            db.run("ALTER TABLE climb_stats ADD COLUMN display_difficulty REAL");
            db.run("UPDATE climb_stats SET display_difficulty = COALESCE(benchmark_difficulty, difficulty_average)");
          }
        } catch (e) { console.warn('[Worker] Schema upgrade warning:', e); }

        // Fetch Similarity Data (Binary + UUID Map)
        Promise.all([
          fetch('/climb_uuids.json').then(r => r.json()),
          fetch('/similarities.bin').then(r => r.arrayBuffer())
        ]).then(([uuids, binBuffer]) => {
          self.climbUuids = uuids;
          self.uuidToIndex = {};
          uuids.forEach((u, i) => self.uuidToIndex[u] = i);
          
          const view = new DataView(binBuffer);
          const numClimbs = view.getUint32(0, true);
          const topK = view.getUint32(4, true); // (Actually not used with offsets, but header has it)
          
          // Offsets: uint32[numClimbs + 1] starts at byte 4 (wait, I wrote numClimbs as first 4 bytes)
          // Wait, let's check my python script:
          // f.write(struct.pack('<I', num_climbs)) -> 4 bytes
          // f.write(struct.pack(f'<{len(offsets)}I', *offsets)) -> (num_climbs + 1) * 4 bytes
          
          self.simOffsets = new Uint32Array(binBuffer, 4, numClimbs + 1);
          
          const dataStart = 4 + (numClimbs + 1) * 4;
          const totalRelationships = self.simOffsets[numClimbs];
          
          self.simTargetIds = new Uint16Array(binBuffer, dataStart, totalRelationships);
          
          const flagsStart = dataStart + totalRelationships * 2;
          self.simMirrorFlags = new Uint8Array(binBuffer, flagsStart, totalRelationships);
          
          console.log('Binary Similarity Data loaded:', numClimbs, 'climbs');
        }).catch(e => console.error('Similarity Data fetch failed:', e));
      }

      // SHARED LOGIC for INIT and READY (Fetch board state)
      if (!db) throw new Error('Database not initialized');

      const res = db.exec(`
        SELECT p.id, h.x, h.y, l.position
        FROM placements p 
        JOIN holes h ON p.hole_id = h.id 
        LEFT JOIN leds l ON h.id = l.hole_id
        WHERE p.layout_id = 11 AND (l.product_size_id = 6 OR l.product_size_id IS NULL)
      `);
      
      let ledMapping = {};
      let placements = [];
      if (res.length > 0) {
        placements = res[0].values.map(row => {
          if (row[3] !== null) ledMapping[row[0]] = row[3];
          return { id: row[0], x: row[1], y: row[2] };
        });
      }

      let angles = [15, 20, 25, 30, 35, 40, 45, 50, 55];
      try {
        const angRes = db.exec(`SELECT angle FROM products_angles WHERE product_id = 5 ORDER BY angle ASC`);
        if (angRes.length > 0) angles = angRes[0].values.map(r => r[0]);
      } catch(e) {}

      let grades = [];
      try {
        const diffRes = db.exec(`SELECT difficulty, boulder_name FROM difficulty_grades WHERE is_listed = 1 ORDER BY difficulty ASC`);
        if (diffRes.length > 0) grades = diffRes[0].values.map(r => ({ id: r[0], name: r[1] }));
      } catch(e) {}

      let boardImages = [];
      try {
        const imgRes = db.exec(`
          SELECT image_filename FROM product_sizes_layouts_sets 
          WHERE layout_id = 11 AND (product_size_id = 6 OR product_size_id IS NULL)
          AND image_filename IS NOT NULL
        `);
        if (imgRes.length > 0) boardImages = imgRes[0].values.map(r => r[0]);
      } catch(e) {}

      self.postMessage({ type: payload.requestId || 'READY', payload: { placements, ledMapping, angles, grades, boardImages, isLocal } });
    } catch (err) {
      self.postMessage({ type: 'ERROR', payload: err.message, requestId: payload.requestId });
    }
    return;
  }

  if (type === 'SEARCH') {
    if (!db) return;
    
    // Check if we have any synced climbs first
    try {
      const syncCheck = db.exec("SELECT COUNT(*) FROM climbs");
      const hasClimbs = syncCheck[0].values[0][0] > 0;

      if (!hasClimbs) {
        self.postMessage({ 
          type: payload.requestId, 
          payload: { routes: [], totalCount: 0, offset: 0, isUnsynced: true } 
        });
        return;
      }
    } catch (e) {
      // If table doesn't exist yet, it's definitely unsynced
      self.postMessage({ 
        type: payload.requestId, 
        payload: { routes: [], totalCount: 0, offset: 0, isUnsynced: true } 
      });
      return;
    }
    const selectedHolds = payload.selectedHolds || []; 
    const limit = payload.limit || 50;
    const offset = payload.offset || 0;

    const roleMapping = {
      'start': 5,
      'middle': 6,
      'finish': 7,
      'foot': 8
    };

    let queryArgs = [];
    let conditions = selectedHolds.map(hold => {
      if (hold.role !== 'any') {
        const roleId = roleMapping[hold.role];
        return `c.frames LIKE '%p${hold.id}r${roleId}%'`;
      } else {
        return `c.frames LIKE '%p${hold.id}r%'`;
      }
    });

    const conditionString = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';

    const filters = payload.filters || {};
    let filterString = '';

    // Status Filters (Sent / Rated)
    const sentUuids = payload.sentUuids || [];
    const ratedUuids = payload.ratedUuids || [];

    if (filters.sentFilter === 'only' && sentUuids.length > 0) {
      filterString += ` AND c.uuid IN ('${sentUuids.join("','")}') `;
    } else if (filters.sentFilter === 'only' && sentUuids.length === 0) {
      filterString += ` AND 1=0 `; // Force empty results
    } else if (filters.sentFilter === 'hide' && sentUuids.length > 0) {
      filterString += ` AND c.uuid NOT IN ('${sentUuids.join("','")}') `;
    }

    if (filters.ratedFilter === 'only' && ratedUuids.length > 0) {
      filterString += ` AND c.uuid IN ('${ratedUuids.join("','")}') `;
    } else if (filters.ratedFilter === 'only' && ratedUuids.length === 0) {
      filterString += ` AND 1=0 `;
    } else if (filters.ratedFilter === 'hide' && ratedUuids.length > 0) {
      filterString += ` AND c.uuid NOT IN ('${ratedUuids.join("','")}') `;
    }
    
    if (filters.angles && filters.angles.length > 0) {
      filterString += ` AND COALESCE(cs.angle, c.angle) IN (${filters.angles.join(',')}) `;
    }

    if (filters.minLength !== undefined && filters.maxLength !== undefined) {
      // Calculate length natively by subtracting frame string total size vs array stripped of standard placement keys 'p' 
      filterString += ` AND (LENGTH(c.frames) - LENGTH(REPLACE(c.frames, 'p', ''))) BETWEEN ${filters.minLength} AND ${filters.maxLength} `;
    }
    
    let gradeConditions = [];
    if (filters.minGrade !== undefined && filters.maxGrade !== undefined) {
      gradeConditions.push(`(ROUND(cs.display_difficulty) >= ${filters.minGrade} AND ROUND(cs.display_difficulty) <= ${filters.maxGrade})`);
      
      if (filters.includeUngraded) {
        gradeConditions.push(`cs.display_difficulty IS NULL`);
      }
    } else if (!filters.includeUngraded) {
      // If no range is selected, but "Include Ungraded" is UNCHECKED, hide the NULLs
      filterString += ` AND cs.display_difficulty IS NOT NULL `;
    }
    
    if (gradeConditions.length > 0) {
      filterString += ` AND (${gradeConditions.join(' OR ')}) `;
    }

    if (filters.routeName) {
      const safeRoute = filters.routeName.replace(/'/g, "''");
      filterString += ` AND c.name LIKE '%${safeRoute}%' `;
    }
    if (filters.setterName) {
      const safeSetter = filters.setterName.replace(/'/g, "''");
      filterString += ` AND c.setter_username LIKE '%${safeSetter}%' `;
    }

    function resolveOrderClause(mode, desc) {
      if (mode === 'none' || !mode) return '';
      
      // Determine the "Natural" forward orientation of the stat
      let forwardDir = 'ASC';
      if (mode === 'popularity' || mode === 'quality' || mode === 'newest') {
        forwardDir = 'DESC'; // Natural forward orientation is high-to-low!
      }
      
      // If user hit the toggle reverse button, flip the natural dir natively
      const sqlDir = desc ? (forwardDir === 'ASC' ? 'DESC' : 'ASC') : forwardDir;

      // Wrap inside aggregations structurally to resolve any grouping collisions safely!
      if (mode === 'difficulty') return `ROUND(MIN(cs.display_difficulty)) IS NULL ASC, ROUND(MIN(cs.display_difficulty)) ${sqlDir}`;
      if (mode === 'popularity') return `SUM(cs.ascensionist_count) IS NULL ASC, SUM(cs.ascensionist_count) ${sqlDir}`;
      if (mode === 'quality') return `MAX(cs.quality_average) IS NULL ASC, MAX(cs.quality_average) ${sqlDir}`;
      if (mode === 'length') return `(LENGTH(c.frames) - LENGTH(REPLACE(c.frames, 'p', ''))) ${sqlDir}`;
      if (mode === 'alphabetical') return `c.name ${sqlDir}`;
      if (mode === 'newest') return `c.created_at ${sqlDir}`;
      if (mode === 'random') return `RANDOM()`;
      return '';
    }

    let orderParts = [];
    const p1 = resolveOrderClause(filters.sortMode, filters.sortDesc);
    if (p1) orderParts.push(p1);
    
    if (filters.secondarySortMode && filters.secondarySortMode !== 'none') {
      const p2 = resolveOrderClause(filters.secondarySortMode, filters.secondarySortDesc);
      if (p2) orderParts.push(p2);
    }
    
    const orderClause = orderParts.length > 0 
      ? `ORDER BY ${orderParts.join(', ')}` 
      : 'ORDER BY ROUND(cs.display_difficulty) IS NULL ASC, ROUND(cs.display_difficulty) ASC';

    const countSql = `
      SELECT count(DISTINCT c.uuid) 
      FROM climbs c
      LEFT JOIN climb_stats cs ON c.uuid = cs.climb_uuid
      WHERE c.layout_id = 11 AND c.is_listed = 1 
      ${conditionString}
      ${filterString}
    `;

    const sql = `
      SELECT 
        c.uuid, 
        c.name, 
        c.setter_username, 
        c.description,
        COALESCE(cs.angle, 'Any') as angle, 
        c.frames, 
        CASE 
          WHEN dg.boulder_name IS NOT NULL THEN dg.boulder_name
          WHEN cs.display_difficulty IS NOT NULL THEN 'V' || (ROUND(cs.display_difficulty) - 10)
          ELSE '--'
        END as grade,
        (SELECT SUM(ascensionist_count) FROM climb_stats WHERE climb_uuid = c.uuid) as ascents,
        AVG(cs.quality_average) as rating
      FROM climbs c
      LEFT JOIN climb_stats cs ON c.uuid = cs.climb_uuid AND cs.angle = c.angle
      LEFT JOIN difficulty_grades dg ON ROUND(cs.display_difficulty) = dg.difficulty
      WHERE c.layout_id = 11 AND c.is_listed = 1 
      ${conditionString}
      ${filterString}
      GROUP BY c.uuid
      ${orderClause}
      LIMIT ${limit} OFFSET ${offset}
    `;

    try {
      // Get absolute total count
      const countRes = db.exec(countSql);
      let totalCount = 0;
      if (countRes.length > 0) {
        totalCount = countRes[0].values[0][0];
      }

      // Get chunk results
      const res = db.exec(sql);
      let routes = [];
      if (res.length > 0) {
        routes = res[0].values.map(row => {
          const frames = row[5] || '';
          // Calculate hold count from frames string (format is like p123r5p456r6...)
          const holdCount = (frames.match(/p/g) || []).length;

          return {
            uuid: row[0],
            name: row[1],
            setter: row[2],
            description: row[3],
            angle: row[4],
            frames: frames,
            grade: row[6],
            ascents: row[7],
            rating: row[8],
            hold_count: holdCount
          };
        });
      }
      self.postMessage({ type: 'RESULTS', payload: { routes, totalCount, offset } });
    } catch(err) {
      self.postMessage({ type: 'ERROR', payload: err.message });
    }
  }

  if (type === 'GET_SIMILAR_CLIMBS') {
    if (!db) return;
    const { uuid, requestId } = payload;

    if (!self.climbUuids || !self.simOffsets) {
      self.postMessage({ type: requestId, payload: [{ isError: true, message: "Similarity data still loading" }] });
      return;
    }

    try {
      const sourceIdx = self.uuidToIndex[uuid];
      if (sourceIdx === undefined) {
        self.postMessage({ type: requestId, payload: [] });
        return;
      }

      const start = self.simOffsets[sourceIdx];
      const end = self.simOffsets[sourceIdx + 1];
      
      const simMap = {};
      const uuids = [];

      for (let i = start; i < end; i++) {
        const targetIdx = self.simTargetIds[i];
        const isMirrored = self.simMirrorFlags[i];
        const tUuid = self.climbUuids[targetIdx];
        
        simMap[tUuid] = { is_mirrored: isMirrored };
        uuids.push(`'${tUuid}'`);
      }

      if (uuids.length === 0) {
        self.postMessage({ type: requestId, payload: [] });
        return;
      }

      // 2. Fetch full metadata from core database
      const sql = `
        SELECT 
          c.uuid, 
          c.name, 
          c.setter_username, 
          c.description,
          COALESCE(c.angle, 'Any') as angle, 
          c.frames, 
          dg.boulder_name,
          SUM(cs.ascensionist_count) as ascents,
          AVG(cs.quality_average) as rating,
          ROUND(cs.display_difficulty) as difficulty
        FROM climbs c
        LEFT JOIN climb_stats cs ON c.uuid = cs.climb_uuid
        LEFT JOIN difficulty_grades dg ON ROUND(cs.display_difficulty) = dg.difficulty
        WHERE c.uuid IN (${uuids.join(',')})
        GROUP BY c.uuid
      `;

      const res = db.exec(sql);
      let routes = [];
      if (res.length > 0) {
        routes = res[0].values.map(row => {
          const tUuid = row[0];
          const frames = row[5] || '';
          const sim = simMap[tUuid];
          return {
            uuid: tUuid,
            name: row[1],
            setter: row[2],
            description: row[3],
            angle: row[4],
            frames: frames,
            grade: row[6],
            ascents: row[7],
            rating: row[8],
            difficulty: row[9],
            is_mirrored_match: sim.is_mirrored === 1,
            hold_count: (frames.match(/p/g) || []).length
          };
        });
      }
      self.postMessage({ type: requestId, payload: routes });
    } catch(err) {
      console.error('Similarity Query Error:', err);
      // Ensure we resolve the promise with an empty array or an error indicator so it doesn't hang!
      self.postMessage({ type: requestId, payload: [{ isError: true, message: err.message }] });
    }
  }

  if (type === 'GET_BY_UUIDS') {
    if (!db) return;
    const uuids = payload.uuids || [];
    const requestId = payload.requestId;

    if (uuids.length === 0) {
      self.postMessage({ type: requestId, payload: [] });
      return;
    }

    const uuidList = uuids.map(u => `'${u}'`).join(',');
    const sql = `
      SELECT 
        c.uuid, 
        c.name, 
        c.setter_username, 
        c.description,
        COALESCE(cs.angle, c.angle, 'Any') as angle, 
        c.frames, 
        dg.boulder_name,
        SUM(cs.ascensionist_count) as ascents,
        AVG(cs.quality_average) as rating,
        ROUND(cs.display_difficulty) as difficulty
      FROM climbs c
      LEFT JOIN climb_stats cs ON c.uuid = cs.climb_uuid
      LEFT JOIN difficulty_grades dg ON ROUND(cs.display_difficulty) = dg.difficulty
      WHERE c.uuid IN (${uuidList})
      GROUP BY c.uuid
    `;

    try {
      const res = db.exec(sql);
      let routes = [];
      if (res.length > 0) {
        routes = res[0].values.map(row => {
          const frames = row[5] || '';
          return {
            uuid: row[0],
            name: row[1],
            setter: row[2],
            description: row[3],
            angle: row[4],
            frames: frames,
            grade: row[6],
            ascents: row[7],
            rating: row[8],
            hold_count: (frames.match(/p/g) || []).length,
            difficulty: row[9]
          };
        });
        
        // Sort routes to exactly match the requested UUIDs order
        const orderMap = {};
        uuids.forEach((u, idx) => { orderMap[u] = idx; });
        routes.sort((a, b) => orderMap[a.uuid] - orderMap[b.uuid]);
      }
      self.postMessage({ type: requestId, payload: routes });
    } catch(err) {
      self.postMessage({ type: 'ERROR', payload: err.message });
    }
  }

  if (type === 'GET_SHARED_SYNC_DATES') {
    if (!db) return;
    try {
      const res = db.exec("SELECT table_name, last_synchronized_at FROM shared_syncs");
      const syncDates = {};
      if (res.length > 0) {
        res[0].values.forEach(row => {
          syncDates[row[0]] = row[1];
        });
      }
      self.postMessage({ type: payload.requestId, payload: syncDates });
    } catch (err) {
      // Table might not exist in a fresh DB
      self.postMessage({ type: payload.requestId, payload: {} });
    }
  }

  if (type === 'PROCESS_SYNC_CHUNK') {
    if (!db) return;
    const { chunk, requestId } = payload;
    const rowCounts = {};

    try {
      console.log('[Worker] Processing sync chunk...');
      db.run("BEGIN TRANSACTION");
      
      for (const [tableName, rows] of Object.entries(chunk)) {
        if (!Array.isArray(rows) || rows.length === 0) continue;

        // Special handling for climb_stats as per BoardLib
        if (tableName === 'climb_stats') {
          const tableInfo = db.exec(`PRAGMA table_info(climb_stats)`);
          const validCols = tableInfo[0].values.map(v => v[1]);

          for (const row of rows) {
            const display_difficulty = row.benchmark_difficulty || row.difficulty_average;
            if (display_difficulty) {
              // Add display_difficulty to the row for insertion
              row.display_difficulty = display_difficulty;
              
              const rowCols = Object.keys(row);
              const colsToInsert = rowCols.filter(c => validCols.includes(c));
              const placeholders = colsToInsert.map(() => '?').join(',');
              const colString = colsToInsert.join(',');
              const values = colsToInsert.map(c => row[c] === undefined ? null : row[c]);
              
              db.run(`INSERT OR REPLACE INTO climb_stats (${colString}) VALUES (${placeholders})`, values);
            } else {
              db.run(`DELETE FROM climb_stats WHERE climb_uuid = ? AND angle = ?`, [row.climb_uuid ?? null, row.angle ?? null]);
            }
          }
        } else {
          // Default generic insert or replace
          // 1. Get actual columns from the database to avoid "no such column" errors
          const tableInfo = db.exec(`PRAGMA table_info(${tableName})`);
          if (tableInfo.length === 0) continue;
          
          const validCols = tableInfo[0].values.map(v => v[1]);
          const rowCols = Object.keys(rows[0]);
          
          // Only use columns that exist in both the API data and the DB
          const colsToInsert = rowCols.filter(c => validCols.includes(c));
          const placeholders = colsToInsert.map(() => '?').join(',');
          const colString = colsToInsert.join(',');
          
          const stmt = db.prepare(`INSERT OR REPLACE INTO ${tableName} (${colString}) VALUES (${placeholders})`);
          for (const row of rows) {
            const values = colsToInsert.map(c => row[c] === undefined ? null : row[c]);
            stmt.run(values);
          }
          stmt.free();
        }
        rowCounts[tableName] = rows.length;
      }
      
      db.run("COMMIT");
      console.log('[Worker] Chunk committed. Exporting and saving...');

      // Save database unless requested otherwise
      if (!payload.noSave) {
        const buffer = db.export();
        await saveToIndexedDB(buffer);
      }

      self.postMessage({ type: requestId, payload: rowCounts });
    } catch (err) {
      db.run("ROLLBACK");
      console.error('[Worker] Sync Error:', err);
      self.postMessage({ type: 'ERROR', payload: err.message });
    }
  }

  if (type === 'SAVE_DB') {
    try {
      const buffer = db.export();
      await saveToIndexedDB(buffer);
      self.postMessage({ type: payload.requestId, payload: 'Database saved successfully' });
    } catch (e) {
      self.postMessage({ type: 'ERROR', payload: e.message });
    }
    return;
  }

  if (type === 'DIAGNOSE') {
    if (!db) return;
    try {
      const totalClimbs = db.exec("SELECT COUNT(*) FROM climbs")[0].values[0][0];
      const listedLayout11 = db.exec("SELECT COUNT(*) FROM climbs WHERE is_listed = 1 AND layout_id = 11")[0].values[0][0];
      const withStatsAnyAngle = db.exec("SELECT COUNT(DISTINCT c.uuid) FROM climbs c JOIN climb_stats cs ON c.uuid = cs.climb_uuid WHERE c.is_listed = 1 AND c.layout_id = 11")[0].values[0][0];
      const withStatsMatchingAngle = db.exec("SELECT COUNT(DISTINCT c.uuid) FROM climbs c JOIN climb_stats cs ON c.uuid = cs.climb_uuid AND cs.angle = c.angle WHERE c.is_listed = 1 AND c.layout_id = 11")[0].values[0][0];
      const zeroAngleClimbs = db.exec("SELECT COUNT(*) FROM climbs WHERE angle = 0 AND is_listed = 1 AND layout_id = 11")[0].values[0][0];
      
      console.log('[Worker Diagnose]', {
        totalClimbs, listedLayout11, withStatsAnyAngle, withStatsMatchingAngle, zeroAngleClimbs
      });
      
      self.postMessage({ 
        type: payload.requestId || 'DIAGNOSE_RESULTS', 
        payload: { 
          totalClimbs, listedLayout11, withStatsAnyAngle, withStatsMatchingAngle, zeroAngleClimbs 
        } 
      });
    } catch (e) {
      console.error('[Worker Diagnose] Error:', e);
      self.postMessage({ type: 'ERROR', payload: e.message });
    }
  }

  if (type === 'APPLY_SYNC') {
    const { tables } = payload;
    try {
      db.run("BEGIN TRANSACTION");
      for (const [tableName, rows] of Object.entries(tables)) {
        if (!rows || rows.length === 0) continue;
        
        // Fetch valid columns for this table and identify NOT NULL columns
        const tableInfo = db.exec(`PRAGMA table_info(${tableName})`);
        if (tableInfo.length === 0) {
          console.warn(`[Worker] Table ${tableName} not found in DB. Skipping.`);
          continue;
        }
        
        // tableInfo values: [cid, name, type, notnull, dflt_value, pk]
        const validColumns = new Set(tableInfo[0].values.map(v => v[1]));
        const notNullColumns = new Set(tableInfo[0].values.filter(v => v[3] === 1 && v[4] === null).map(v => v[1]));

        // Get columns from first row, but ONLY those that exist in our DB
        const incomingColumns = Object.keys(rows[0]);
        const columnsToInsert = incomingColumns.filter(col => validColumns.has(col));
        
        if (columnsToInsert.length === 0) continue;

        const placeholders = columnsToInsert.map(() => '?').join(',');
        const sql = `INSERT OR REPLACE INTO ${tableName} (${columnsToInsert.join(',')}) VALUES (${placeholders})`;
        
        const stmt = db.prepare(sql);
        for (const row of rows) {
          // Validate NOT NULL constraints
          let isValid = true;
          for (const col of notNullColumns) {
            if (row[col] === null || row[col] === undefined) {
              isValid = false;
              break;
            }
          }
          if (!isValid) continue;

          const values = columnsToInsert.map(col => {
            const val = row[col];
            return val === undefined ? null : val;
          });
          stmt.run(values);
        }
        stmt.free();
      }
      db.run("COMMIT");
      self.postMessage({ type: payload.requestId, payload: 'Sync applied successfully' });
    } catch (e) {
      if (db) db.run("ROLLBACK");
      console.error('[Worker] Apply Sync Error:', e);
      self.postMessage({ type: 'ERROR', payload: e.message });
    }
    return;
  }

  if (type === 'REPLACE_DB') {
    const { buffer } = payload;
    try {
      if (!self.SQL_LIB) throw new Error('SQL library not initialized');
      if (db) db.close();
      db = new self.SQL_LIB.Database(new Uint8Array(buffer));
      await saveToIndexedDB(buffer);
      self.postMessage({ type: payload.requestId, payload: 'Database replaced successfully' });
      // Re-init placements and board state
      self.onmessage({ data: { type: 'INIT', payload: {} } });
    } catch (e) {
      console.error('[Worker] Replace DB Error:', e);
      self.postMessage({ type: 'ERROR', payload: e.message });
    }
    return;
  }
  if (type === 'SAVE_IMAGE') {
    const { filename, buffer } = payload;
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction(IMAGE_STORE_NAME, 'readwrite');
        const store = transaction.objectStore(IMAGE_STORE_NAME);
        store.put(buffer, filename);
        transaction.oncomplete = () => self.postMessage({ type: payload.requestId, payload: 'Image saved' });
      };
    } catch (e) {
      self.postMessage({ type: 'ERROR', payload: e.message });
    }
    return;
  }

  if (type === 'GET_IMAGE') {
    const { filename } = payload;
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction(IMAGE_STORE_NAME, 'readonly');
        const store = transaction.objectStore(IMAGE_STORE_NAME);
        const getRequest = store.get(filename);
        getRequest.onsuccess = () => self.postMessage({ type: payload.requestId, payload: getRequest.result });
      };
    } catch (e) {
      self.postMessage({ type: 'ERROR', payload: e.message });
    }
    return;
  }
};
