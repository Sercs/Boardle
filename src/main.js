import { DatabaseClient } from './database.js';
import { RadialMenu } from './radial-menu.js';
import { BottomSheet } from './bottom-sheet.js';
import { BluetoothAPI } from './bluetooth.js';
import { Logbook } from './logbook.js';
import { getImageUrl, fetchDatabase, fetchImage } from './aurora-api.js';

let dbClient;
let radialMenu;
let bottomSheet;
let bluetoothController;
let logbook;

let placements = []; // { id, x, y }
let ledMapping = {}; // { id: position }
let selectedHolds = []; // { id, role }
let currentRoutes = [];
let currentRouteIndex = -1;
let currentClimb = null; // Track the currently active climb for auto-relighting

let currentOffset = 0;
let totalResultsCount = 0;
let isLoadingRoutes = false;

let isLiveMode = false; // Default: Passive Mode (Double tap to broadcast)
let connectionStatus = 'disconnected'; // disconnected, connected
let isMockBT = false; // TEMPORARY: Allow testing UI without physical board
let isConnecting = false;

let systemGrades = [];
let systemAngles = [];

let filterState = {
  angles: [],
  gradeLocked: false,
  minGrade: null,
  maxGrade: null,
  lengthLocked: false,
  minLength: 2,
  maxLength: 40,
  includeUngraded: true,
  sortMode: 'popularity', // Primary: Popularity
  sortDesc: false,        // High-to-low (most popular first)
  secondarySortMode: 'random', // Secondary: Feeling Lucky
  secondarySortDesc: false,
  routeName: '',
  setterName: '',
  sentFilter: 'all',  // all, only, hide
  ratedFilter: 'all'  // all, only, hide
};

// Recommendation Mode State
let recommendationStack = []; // Stack of { climb, results }
let ignoreFiltersInRecommendations = true;
// topKSimilarity removed, now using SQLite

let boardX = 0;
let boardY = 0;
let boardScale = 1.0;

let isInMapMode = false;
let panStartX = 0;
let panStartY = 0;
let initialBoardX = 0;
let initialBoardY = 0;
let initialScale = 1.0;
let initialDist = 0;
let focalPointX = 0;
let focalPointY = 0;
let isElasticSnapping = false;

let lastTapTime = 0;
let lastPointerId = null;
let isRecentering = false;
let selectionPendingTimer = null;
let touchStartX = 0;
let touchStartY = 0;
let hadMapModeThisSession = false;
// ... (omitted middle code for brevity)

async function reinitializeUI(readyPayload) {
  // If no payload provided, request it from the worker
  if (!readyPayload) {
    const requestId = `refresh_state_${Date.now()}`;
    readyPayload = await new Promise(resolve => {
      const handler = (e) => {
        if (e.data.type === requestId || e.data.type === 'READY') {
          dbClient.worker.removeEventListener('message', handler);
          resolve(e.data.payload);
        }
      };
      dbClient.worker.addEventListener('message', handler);
      dbClient.worker.postMessage({ type: 'GET_STATE', payload: { requestId } }); 
    });
  }

  // Check sync status now that DB is ready
  
  // Show/Hide Setup Screen
  const setupScreen = document.getElementById('setup-screen');
  if (setupScreen) {
    if (!readyPayload.isLocal) {
      setupScreen.classList.remove('hidden');
    } else {
      setupScreen.classList.add('hidden');
    }
  }
  
  placements = readyPayload.placements;
  if (readyPayload.ledMapping) ledMapping = readyPayload.ledMapping;

  // Dynamically load board images
  if (readyPayload.boardImages && readyPayload.boardImages.length > 0) {
    const imagesContainer = document.getElementById('board-images');
    const holdsContainer = document.getElementById('holds-container');
    imagesContainer.innerHTML = '';
    
    const imagePromises = readyPayload.boardImages.map(async (filename) => {
      const img = document.createElement('img');
      img.className = 'board-layer';
      
      // Try local image first
      const localBuffer = await dbClient.getImage(filename);
      if (localBuffer) {
        const blob = new Blob([localBuffer]);
        img.src = URL.createObjectURL(blob);
        console.log(`[Images] Using local version of ${filename}`);
      } else {
        console.log(`[Images] Fetching ${filename} from API for caching...`);
        try {
          const blob = await fetchImage('tension', filename);
          img.src = URL.createObjectURL(blob);
          
          // Save to local IndexedDB for next time
          const buffer = await blob.arrayBuffer();
          await dbClient.saveImage(filename, buffer);
        } catch (e) {
          console.error(`[Images] Failed to cache ${filename}, falling back to direct proxy:`, e);
          img.src = getImageUrl('tension', filename);
        }
      }

      img.onerror = () => {
        console.error(`Failed to load board image: ${filename}`);
        img.style.display = 'none';
      };
      
      return img;
    });

    const loadedImages = await Promise.all(imagePromises);
    loadedImages.forEach(img => imagesContainer.appendChild(img));
    imagesContainer.appendChild(holdsContainer);
  } else {
    // Fallback if no images found
    console.warn("[Main] No board images found in database.");
  }

  systemAngles = readyPayload.angles || [];
  systemGrades = readyPayload.grades || [];

  renderHolds();

  // Update filters with new grades/angles
  if (typeof updateFilterDropdowns === 'function') {
    updateFilterDropdowns();
  }
}

window.reinitApp = reinitializeUI;

class CoPilot {
  constructor() {
    this.session = null;
    this.isLoaded = false;
    this.isLoading = false;
    this.suggestion = null;
    
    // Stateful CDF Explorer
    this.lastContextKey = "";
    this.rankedIdPool = [];
    this.currentIdOffset = 0;
  }

  async load() {
    if (this.isLoaded || this.isLoading) return;
    this.isLoading = true;
    try {
      this.session = await ort.InferenceSession.create('./models/climb_generator.onnx');
      this.isLoaded = true;
      console.log("[CoPilot] ONNX Model Loaded Successfully.");
    } catch (e) {
      console.error("[CoPilot] Error loading model:", e);
    } finally {
      this.isLoading = false;
    }
  }

  async getSuggestions(holds, count = 5, excludeIds = []) {
    if (!this.isLoaded) await this.load();
    if (!this.session) return [];

    try {
      const roleMap = { 1: 0, 5: 0, 2: 1, 6: 1, 3: 2, 7: 2, 4: 3, 8: 3 };
      const JOINT_VOCAB_SIZE = 7500;
      const START_ID = 7500;
      const PAD_ID = 7501;
      const MAX_TOKENS = 30;

      const contextKey = holds.map(h => `${h.id}_${h.role}`).sort().join('|');
      
      const getSortedDistribution = (logits, offset, size, temperature = 1.0) => {
        let maxL = -Infinity;
        for (let i = 0; i < size; i++) if (logits[offset + i] > maxL) maxL = logits[offset + i];
        let probs = [], total = 0;
        for (let i = 0; i < size; i++) {
          const p = Math.exp((logits[offset + i] - maxL) / temperature);
          probs.push({id: i, p: p}); total += p;
        }
        probs.forEach(e => e.p /= total);
        return probs.sort((a, b) => b.p - a.p);
      };

      const runInference = async (inputTokens, inputCoords) => {
        const paddedTokens = new BigInt64Array(MAX_TOKENS).fill(BigInt(PAD_ID));
        const paddedCoords = new Float32Array(MAX_TOKENS * 2).fill(0);
        for (let i = 0; i < inputTokens.length; i++) paddedTokens[i] = BigInt(inputTokens[i]);
        paddedCoords.set(inputCoords);
        const mask = new Float32Array(MAX_TOKENS * MAX_TOKENS);
        for (let i = 0; i < MAX_TOKENS; i++) {
          for (let j = 0; j < MAX_TOKENS; j++) mask[i * MAX_TOKENS + j] = (j <= i) ? 0 : -1e9;
        }
        const feeds = {};
        if (this.session.inputNames.includes('tokens')) feeds.tokens = new ort.Tensor('int64', paddedTokens, [1, MAX_TOKENS]);
        if (this.session.inputNames.includes('coords')) feeds.coords = new ort.Tensor('float32', paddedCoords, [1, MAX_TOKENS, 2]);
        if (this.session.inputNames.includes('mask')) feeds.mask = new ort.Tensor('float32', mask, [MAX_TOKENS, MAX_TOKENS]);
        return await this.session.run(feeds);
      };

      if (contextKey !== this.lastContextKey) {
        this.lastContextKey = contextKey;
        this.currentIdOffset = 0;
        
        const numTokens = holds.length + 1;
        const baseTokens = new Int32Array(numTokens);
        const baseCoords = new Float32Array(numTokens * 2);
        baseTokens[0] = START_ID;
        holds.forEach((h, idx) => {
          const base = idx + 1;
          const node = placements.find(n => n.id == h.id);
          if (!node) return;
          baseTokens[base] = (h.id * 5) + (roleMap[h.role] ?? 1);
          baseCoords[base * 2] = node.x / 88; baseCoords[base * 2 + 1] = node.y / 152;
        });

        const output = await runInference(baseTokens, baseCoords);
        const vocabSize = output.logits.dims[2];
        const dist = getSortedDistribution(output.logits.data, (numTokens - 1) * vocabSize, JOINT_VOCAB_SIZE, 1.0);
        
        this.rankedIdPool = [];
        let cumSum = 0;
        for (let entry of dist) {
          const holdId = Math.floor(entry.id / 5);
          if (holdId <= 0 || holds.some(h => h.id == holdId)) continue;
          this.rankedIdPool.push(entry.id);
          cumSum += entry.p; if (cumSum >= 0.95) break;
        }
      }

      const suggestions = [];
      const batchJointTokens = this.rankedIdPool.slice(this.currentIdOffset, this.currentIdOffset + count);
      this.currentIdOffset += count;

      for (const jointToken of batchJointTokens) {
        const holdId = Math.floor(jointToken / 5);
        let roleIdx = jointToken % 5;
        if (excludeIds.includes(holdId)) continue;
        
        const node = placements.find(n => n.id == holdId);
        if (!node) continue;
        
        // If the model predicts a Distractor (4), promote to Intermediate (1) for functional use
        if (roleIdx === 4) roleIdx = 1;

        const invRoleMap = { 0: 5, 1: 6, 2: 7, 3: 8 };
        const role = invRoleMap[roleIdx] || 6;
        suggestions.push({ id: holdId, role: role, x: node.x, y: node.y });
      }
      return suggestions;
    } catch (e) {
      console.error("[CoPilot] Error generating suggestions:", e);
      return [];
    }
  }
}

class SetterState {
  constructor(initialHolds = []) {
    this.history = [JSON.parse(JSON.stringify(initialHolds))];
    this.index = 0;
  }

  get current() {
    return this.history[this.index];
  }

  push(holds) {
    this.history = this.history.slice(0, this.index + 1);
    this.history.push(JSON.parse(JSON.stringify(holds)));
    this.index++;
    if (this.history.length > 50) this.history.shift();
  }

  undo() {
    if (this.index > 0) {
      this.index--;
      return true;
    }
    return false;
  }

  redo() {
    if (this.index < this.history.length - 1) {
      this.index++;
      return true;
    }
    return false;
  }

  toggleHold(id, role = 6, forceDelete = false) {
    let next = [...this.current];
    const existing = next.findIndex(h => h.id == id);
    if (existing > -1) {
      if (forceDelete || next[existing].role == role) {
        next.splice(existing, 1);
      } else {
        next[existing].role = role;
      }
    } else {
      next.push({ id, role });
    }
    this.push(next);
    // Explicitly reset suggestion index when route changes
    if (setterController) {
      setterController.suggestionStack = [];
      setterController.suggestionIndex = -1;
    }
  }

  clear() { this.push([]); }

  getFrames() {
    return this.current.map(h => `p${h.id}r${h.role}`).join('');
  }
}

async function syncSetterToBoard(options = {}) {
  const { skipAI = false } = options;
  if (!setterController || !setterController.isActive) return;
  
  const frames = setterController.state.getFrames();
  const suggestion = (setterController.isWandActive) ? setterController.copilot.suggestion : null;
  
  // 1. Update UI
  renderRoute({ frames, suggestion });

  const clearBtn = document.getElementById('setter-clear-btn');
  if (clearBtn) {
    clearBtn.classList.toggle('faded', setterController.state.current.length === 0);
  }
  
  // 2. Update Physical Board
  if (bluetoothController && bluetoothController.isConnected && isLiveMode) {
    await bluetoothController.lightRoute(frames, ledMapping);
    if (currentClimb) logbook.addIlluminated(currentClimb.uuid);
  }
  
  // 3. Trigger AI if active
  if (setterController.isWandActive && !skipAI) {
    setterController.updateSuggestion();
  }
}

class SetterController {
  constructor() {
    this.isActive = false;
    this.isWandActive = false;
    this.startY = 0;
    this.currentY = 0;
    this.threshold = 60;
    this.offsetClosed = -60;
    this.state = new SetterState();
    this.defaultRole = 6;
    this.copilot = new CoPilot();
    
    // Inspiration Tower
    this.suggestionStack = [];
    this.suggestionIndex = -1;
    this.isGenerating = false;

    this.init();
  }

  async updateSuggestion(prepend = false) {
    if (this.isGenerating) return;
    this.isGenerating = true;
    
    const overlay = document.getElementById('setter-overlay');
    if (overlay) overlay.classList.add('wand-thinking');

    try {
      const excludeIds = this.suggestionStack.map(s => s.id);
      const suggestions = await this.copilot.getSuggestions(this.state.current, 5, excludeIds);
      
      if (suggestions && suggestions.length > 0) {
        if (prepend) {
          this.suggestionStack = [...suggestions.reverse(), ...this.suggestionStack];
          this.suggestionIndex = 0;
        } else {
          this.suggestionStack = [...this.suggestionStack, ...suggestions];
          this.suggestionIndex = this.suggestionStack.length - suggestions.length;
        }
        this.copilot.suggestion = this.suggestionStack[this.suggestionIndex];
        syncSetterToBoard({ skipAI: true });
      }
    } finally {
      this.isGenerating = false;
      if (overlay) overlay.classList.remove('wand-thinking');
    }
  }

  nextSuggestion(direction) {
    if (this.isGenerating) return;
    if (direction === 1) { // Down: FORWARD / NEW
      if (this.suggestionIndex < this.suggestionStack.length - 1) {
        // Scrub forward through existing history
        this.suggestionIndex++;
        this.copilot.suggestion = this.suggestionStack[this.suggestionIndex];
        syncSetterToBoard({ skipAI: true });
      } else {
        // At the top of the tower, generate a brand new move
        this.updateSuggestion(false);
      }
    } else if (direction === -1) { // Up: BACKWARD / NEW
      if (this.suggestionIndex > 0) {
        this.suggestionIndex--;
        this.copilot.suggestion = this.suggestionStack[this.suggestionIndex];
        syncSetterToBoard({ skipAI: true });
      } else {
        // At the bottom of history, generate a new alternative at the start
        this.updateSuggestion(true);
      }
    }
  }

  init() {
    const overlay = document.getElementById('setter-overlay');
    const handleZone = document.getElementById('setter-handle-zone');
    const wand = document.getElementById('setter-wand-btn');
    const roleSelector = document.getElementById('setter-role-selector');

    roleSelector.querySelectorAll('.role-ring').forEach(ring => {
      ring.addEventListener('click', () => {
        this.defaultRole = parseInt(ring.dataset.role);
        roleSelector.querySelectorAll('.role-ring').forEach(r => r.classList.remove('active'));
        ring.classList.add('active');
      });
    });

    const setterPill = document.getElementById('setter-pill');
    setterPill.addEventListener('click', (e) => {
      e.stopPropagation();
      if (document.getElementById('filter-sidebar').classList.contains('open') || 
          document.getElementById('info-sidebar').classList.contains('open')) {
        return;
      }
      isLiveMode = !isLiveMode;
      updateIndicatorUI();
      const indicator = (connectionStatus === 'connected') ? "🟢" : "🔴";
      const statusLabel = (connectionStatus === 'connected') ? "Connected" : "Disconnected";
      const modeLabel = isLiveMode ? "Live" : "Passive";
      showToast(`${indicator} ${statusLabel} ${modeLabel}`, 1000);
      if (isLiveMode) syncSetterToBoard();
    });

    handleZone.addEventListener('touchstart', e => {
      this.startY = e.touches[0].clientY;
      this.currentY = this.startY;
      overlay.style.transition = 'none';
      document.body.classList.add('dragging-setter');
    }, { passive: true });

    handleZone.addEventListener('touchmove', e => {
      this.currentY = e.touches[0].clientY;
      const delta = this.currentY - this.startY;
      
      if (!this.isActive && delta > 0) {
        const pull = Math.min(this.offsetClosed + delta, 20); 
        overlay.style.transform = `translateY(${pull}px)`;
      } else if (this.isActive && delta < 0) {
        const pull = Math.max(delta, this.offsetClosed - 20);
        overlay.style.transform = `translateY(${pull}px)`;
      }
    }, { passive: true });

    handleZone.addEventListener('touchend', () => {
      const delta = this.currentY - this.startY;
      overlay.style.transition = 'transform 0.4s cubic-bezier(0.32, 0.72, 0, 1)';
      document.body.classList.remove('dragging-setter');

      if (!this.isActive && delta > this.threshold) {
        this.enter();
      } else if (this.isActive && delta < -this.threshold) {
        this.exit();
      } else {
        overlay.style.transform = '';
      }
      this.startY = 0;
      this.currentY = 0;
    });

    const clearBtn = document.getElementById('setter-clear-btn');
    clearBtn.addEventListener('click', () => {
      this.state.clear();
      this.suggestionStack = [];
      this.suggestionIndex = -1;
      syncSetterToBoard();
      showToast("Board Cleared", 1000);
    });

    wand.addEventListener('click', async (e) => {
      e.stopPropagation();
      this.isWandActive = !this.isWandActive;
      wand.classList.toggle('active', this.isWandActive);
      
      if (this.isWandActive) {
        document.getElementById('setter-overlay').classList.add('wand-thinking');
        await this.copilot.load();
        this.suggestionStack = [];
        this.updateSuggestion();
        document.getElementById('setter-overlay').classList.remove('wand-thinking');
      } else {
        this.copilot.suggestion = null;
        syncSetterToBoard();
        showToast("AI Co-Pilot: OFF", 1000);
      }
    });
  }

  enter() {
    this.isActive = true;
    
    // Initialize state from current climb if it exists
    let initialHolds = [];
    if (currentClimb && currentClimb.frames) {
      const p_regex = /p(\d+)r(\d+)/g;
      let match;
      while ((match = p_regex.exec(currentClimb.frames)) !== null) {
        initialHolds.push({ id: match[1], role: match[2] });
      }
    }
    this.state = new SetterState(initialHolds);
    
    document.body.classList.add('setter-mode');
    document.getElementById('setter-overlay').style.transform = 'translateY(0)';
    showToast("Edit Mode", 1000);
    syncSetterToBoard();
    updateIndicatorUI();
  }

  async exit() {
    this.isActive = false;
    document.body.classList.remove('setter-mode');
    document.getElementById('setter-overlay').style.transform = '';
    
    // Restore the current climb to the board
    if (currentClimb) {
      renderRoute(currentClimb);
      if (bluetoothController.isConnected && isLiveMode) {
        await bluetoothController.lightRoute(currentClimb.frames, ledMapping);
        logbook.addIlluminated(currentClimb.uuid);
      }
    } else {
      renderRoute(null);
    }
    updateIndicatorUI();
  }
}




let setterController;
let lastTouchCount = 0;

let activePointerCount = 0;
let hadRadialMenuThisSession = false;

async function init() {
  console.log('Main.js Init Started');
  dbClient = new DatabaseClient();
  dbClient.setOnResults(handleRoutesUpdate);
  bluetoothController = new BluetoothAPI();
  logbook = new Logbook();
  updateIndicatorUI();

  radialMenu = new RadialMenu(
    document.getElementById('radial-menu'),
    handleHoldSelect
  );

  bottomSheet = new BottomSheet(document.getElementById('bottom-sheet'));
  setterController = new SetterController();

  // Initial Setup Screen logic
  const setupBtn = document.getElementById('setup-fetch-btn');
  if (setupBtn) {
    setupBtn.onclick = async () => {
      const progressContainer = document.getElementById('setup-progress-container');
      const statusText = document.getElementById('setup-status');
      const progressFill = document.getElementById('setup-progress-fill');
      
      if (progressContainer) progressContainer.classList.remove('hidden');
      setupBtn.classList.add('hidden');

      try {
        if (statusText) statusText.textContent = 'Initializing download...';
        
        const buffer = await fetchDatabase('tension', (progress) => {
          const pct = Math.round(progress * 100);
          if (progressFill) progressFill.style.width = `${pct * 0.8}%`; // Reserve 20% for installation
          if (statusText) statusText.textContent = `Downloading database: ${pct}% (~80MB)`;
        });
        
        if (statusText) statusText.textContent = 'Installing database...';
        if (progressFill) progressFill.style.width = '90%';
        
        await dbClient.replaceDatabase(buffer);
        
        if (progressFill) progressFill.style.width = '100%';
        const screen = document.getElementById('setup-screen');
        if (screen) screen.classList.add('hidden');
        showToast("Boardle Initialized!", 3000);
        if (window.reinitApp) await window.reinitApp();
      } catch (err) {
        console.error('Setup Error:', err);
        alert(`Initialization Failed: ${err.message}`);
        setupBtn.classList.remove('hidden');
        if (progressContainer) progressContainer.classList.add('hidden');
      }
    };
  }

  const importBtn = document.getElementById('setup-import-btn');
  const fileInput = document.getElementById('setup-file-input');
  if (importBtn && fileInput) {
    importBtn.onclick = () => fileInput.click();
    fileInput.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      
      const setupActions = document.getElementById('setup-actions');
      const progressContainer = document.getElementById('setup-progress-container');
      const statusText = document.getElementById('setup-status');
      const progressFill = document.getElementById('setup-progress-fill');

      try {
        if (setupActions) setupActions.classList.add('hidden');
        if (progressContainer) progressContainer.classList.remove('hidden');
        if (statusText) statusText.textContent = `Reading ${file.name}...`;
        
        const buffer = await file.arrayBuffer();
        if (progressFill) progressFill.style.width = '50%';
        if (statusText) statusText.textContent = 'Installing database...';
        
        await dbClient.replaceDatabase(buffer);
        if (progressFill) progressFill.style.width = '100%';
        
        const screen = document.getElementById('setup-screen');
        if (screen) screen.classList.add('hidden');
        showToast("Boardle Initialized!", 3000);
        
        if (window.reinitApp) {
          await window.reinitApp();
        }
      } catch (err) {
        alert(`Import Failed: ${err.message}`);
        if (setupActions) setupActions.classList.remove('hidden');
        if (progressContainer) progressContainer.classList.add('hidden');
      }
    };
  }

  console.log('Awaiting dbClient.init()...');
  const readyPayload = await dbClient.init();
  console.log('dbClient Ready!', readyPayload);
  
  // Trigger diagnostic to understand climb counts
  dbClient.worker.postMessage({ type: 'DIAGNOSE', payload: { requestId: 'init_diagnose' } });
  
  await reinitApp(readyPayload);

  // Recommendation Mode: Back
  document.getElementById('rec-back-btn').onclick = handleRecBack;
  document.getElementById('rec-home-btn').onclick = handleRecHome;
  document.getElementById('rec-filter-btn').onclick = handleRecFilterToggle;

  initFilterSidebar();
  
  window.reinitApp = async () => {
    // 1. Flush ALL state globally and UI elements SILENTLY
    currentClimb = null;
    currentRoutes = [];
    currentRouteIndex = -1;
    recommendationStack = [];
    totalResultsCount = 0;
    isLoadingRoutes = false;
    
    clearAllFilters(true);
    clearHoldFilters(true);
    
    // Defensive triple-clear
    selectedHolds.length = 0; 

    // Explicitly force the clear button UI off
    const clearHoldsBtn = document.getElementById('clear-hold-filters-btn');
    if (clearHoldsBtn) clearHoldsBtn.classList.add('inactive');

    const readyPayload = await dbClient.refreshBoardState();
    
    // 2. Re-initialize board data (placements, images, etc.)
    await reinitializeUI(readyPayload);
    
    // 3. Ensure board is visually empty
    renderRoute(null);
    updateHoldsUI(); 
    
    // 4. Trigger exactly ONE search from a clean slate
    triggerSearch(true);
  };

  document.getElementById('clear-all-filters-btn').onclick = clearAllFilters;
  document.getElementById('clear-hold-filters-btn').onclick = clearHoldFilters;

  const btBtn = document.getElementById('bluetooth-connect-btn');
  if (btBtn) {
    btBtn.onclick = () => handleConnectBoard(true);
  }

  bottomSheet.setOnSwipe((direction) => {
    if (direction === 'left') {
      switchTab(true); // Switch to History
    } else {
      switchTab(false); // Switch to Discover
    }
  });

  bottomSheet.setOnTap((e) => {
    // Only toggle if we clicked the pill
    if (!e.target.closest('#bottom-sheet-pill')) return;

    if (document.getElementById('filter-sidebar').classList.contains('open') || 
        document.getElementById('info-sidebar').classList.contains('open')) {
      return;
    }

    // Toggle modes (Always works, even if disconnected)
    isLiveMode = !isLiveMode;
    updateIndicatorUI();
    
    // Feedback based on state
    const indicator = (connectionStatus === 'connected') ? "🟢" : "🔴";
    const statusLabel = (connectionStatus === 'connected') ? "Connected" : "Disconnected";
    const modeLabel = isLiveMode ? "Live" : "Passive";
    
    showToast(`${indicator} ${statusLabel} ${modeLabel}`);

    // Immediately sync current climb if toggling Live mode ON
    if (isLiveMode && bluetoothController.isConnected) {
      if (setterController && setterController.isActive) {
        bluetoothController.lightRoute(setterController.state.getFrames(), ledMapping);
      } else if (currentClimb) {
        bluetoothController.lightRoute(currentClimb.frames, ledMapping);
        logbook.addIlluminated(currentClimb.uuid);
      }
    }
  });

  renderHolds();

  setupTouchInteractions();
  setupScrollLoading();

  // Initial load
  triggerSearch();

  // Global Keyboard Shortcuts
  window.addEventListener('keydown', (e) => {
    // Ignore if typing in an input
    if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;

    if (e.key.toLowerCase() === 'e') {
      if (setterController) {
        if (!setterController.isActive) {
          setterController.enter();
        } else {
          setterController.exit();
        }
      }
    }
    
    // Esc to exit edit mode if active
    if (e.key === 'Escape' && setterController && setterController.isActive) {
      setterController.exit();
    }
  });
}

function renderHolds() {
  const container = document.getElementById('holds-container');
  container.innerHTML = '';

  // Board dimensions from product_sizes for 12x12
  const minX = -68, maxX = 68, rangeX = maxX - minX;
  const minY = 0, maxY = 144, rangeY = maxY - minY;

  placements.forEach(p => {
    const hold = document.createElement('div');
    hold.className = 'hold';
    hold.dataset.id = p.id;

    // Calculate percentages
    const xPct = ((p.x - minX) / rangeX) * 100;
    // y=4 is bottom, so we invert Y for CSS top
    const yPct = 100 - ((p.y - minY) / rangeY) * 100;

    hold.style.left = `${xPct}%`;
    hold.style.top = `${yPct}%`;

    container.appendChild(hold);
  });
  updateClearButtonsUI();
}

function updateClearButtonsUI() {
  const clearAllBtn = document.getElementById('clear-all-filters-btn');
  const clearHoldsBtn = document.getElementById('clear-hold-filters-btn');
  if (!clearAllBtn || !clearHoldsBtn) return;

  // Filter out any junk or empty objects
  const validHolds = selectedHolds.filter(h => h && (h.id !== undefined && h.id !== null));
  const hasHoldFilters = validHolds.length > 0;
  
  if (hasHoldFilters) {
    console.log("[Main] Hold Filters Active:", JSON.stringify(validHolds));
  }
  
  // Check if any non-default filters are set
  const hasRouteName = filterState.routeName !== '';
  const hasSetterName = filterState.setterName !== '';
  const hasAngles = filterState.angles.length > 0;
  const hasSentFilter = filterState.sentFilter !== 'all';
  const hasRatedFilter = filterState.ratedFilter !== 'all';
  const hasSortChanged = filterState.sortMode !== 'popularity' || filterState.sortDesc !== false;
  
  // Check grades/length against system defaults if available
  let hasGradeFilter = false;
  if (systemGrades.length > 0) {
    const defaultMin = systemGrades[0].id;
    const defaultMax = systemGrades[systemGrades.length - 1].id;
    hasGradeFilter = filterState.minGrade !== defaultMin || filterState.maxGrade !== defaultMax || filterState.gradeLocked;
  }
  
  const hasLengthFilter = filterState.minLength !== 2 || filterState.maxLength !== 40 || filterState.lengthLocked;
  const hasUngradedChanged = filterState.includeUngraded !== true;

  const isAnyFilterActive = hasRouteName || hasSetterName || hasAngles || hasSentFilter || hasRatedFilter || hasSortChanged || hasGradeFilter || hasLengthFilter || hasUngradedChanged;

  clearAllBtn.classList.toggle('inactive', !isAnyFilterActive);
  clearHoldsBtn.classList.toggle('inactive', !hasHoldFilters);
}

function clearAllFilters(silent = false) {
  filterState.routeName = '';
  filterState.setterName = '';
  filterState.angles = [];
  filterState.sentFilter = 'all';
  filterState.ratedFilter = 'all';
  filterState.sortMode = 'popularity';
  filterState.sortDesc = false;
  filterState.secondarySortMode = 'random';
  filterState.secondarySortDesc = false;
  filterState.includeUngraded = true;
  filterState.gradeLocked = false;
  filterState.lengthLocked = false;
  filterState.minLength = 2;
  filterState.maxLength = 40;

  if (systemGrades.length > 0) {
    filterState.minGrade = systemGrades[0].id;
    filterState.maxGrade = systemGrades[systemGrades.length - 1].id;
  }

  // Update UI elements in sidebar
  const routeInput = document.getElementById('route-name-input');
  if (routeInput) routeInput.value = '';
  const setterInput = document.getElementById('setter-name-input');
  if (setterInput) setterInput.value = '';
  const ungradedCb = document.getElementById('include-ungraded-cb');
  if (ungradedCb) ungradedCb.checked = true;
  const orderSel = document.getElementById('order-select');
  if (orderSel) orderSel.value = 'popularity';
  const secOrderSel = document.getElementById('secondary-order-select');
  if (secOrderSel) secOrderSel.value = 'random';
  
  const padlockImg = document.getElementById('padlock-img');
  const padlock = document.getElementById('padlock-btn');
  if (padlockImg) padlockImg.src = '/icons/unlock.svg';
  if (padlock) padlock.classList.add('unlocked');
  const maxGradeSel = document.getElementById('max-grade-select');
  if (maxGradeSel) maxGradeSel.disabled = false;
  
  const lenPadlockImg = document.getElementById('length-padlock-img');
  const lenPadlock = document.getElementById('length-padlock-btn');
  if (lenPadlockImg) lenPadlockImg.src = '/icons/unlock.svg';
  if (lenPadlock) lenPadlock.classList.add('unlocked');
  const maxLenSel = document.getElementById('max-length-select');
  if (maxLenSel) maxLenSel.disabled = false;

  if (systemGrades.length > 0) {
    const minGradeSel = document.getElementById('min-grade-select');
    if (minGradeSel) minGradeSel.value = filterState.minGrade;
    if (maxGradeSel) maxGradeSel.value = filterState.maxGrade;
  }
  const minLenSel = document.getElementById('min-length-select');
  if (minLenSel) minLenSel.value = 2;
  if (maxLenSel) maxLenSel.value = 40;

  document.querySelectorAll('#angle-toggles button').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('#sent-toggles button').forEach(b => {
    b.classList.toggle('active', b.dataset.value === 'all');
  });
  document.querySelectorAll('#rated-toggles button').forEach(b => {
    b.classList.toggle('active', b.dataset.value === 'all');
  });

  updateClearButtonsUI();

  if (silent !== true) {
    if (recommendationStack.length > 0) {
      ignoreFiltersInRecommendations = false; 
      renderRecommendationResults();
    } else {
      triggerSearch();
    }
    showToast("Filters Cleared", 800);
  }
}

function clearHoldFilters(silent = false) {
  console.log("[Main] Clearing Hold Filters. Current count:", selectedHolds.length);
  selectedHolds.length = 0; // Clear in-place to affect all references
  updateHoldsUI();
  updateClearButtonsUI();

  if (silent !== true) {
    if (recommendationStack.length > 0) {
      renderRecommendationResults();
    } else {
      triggerSearch();
    }
    showToast("Holds Cleared", 800);
  }
}

function triggerSearch(resetOffset = true) {
  updateClearButtonsUI();
  // If we are in recommendation mode and IGNORING filters, don't trigger anything.
  // We only care about filter changes if we are actually applying them!
  if (recommendationStack.length > 0 && ignoreFiltersInRecommendations) {
    return;
  }

  // If we are in recommendation mode and filters are ON, refresh the recommendation view.
  if (recommendationStack.length > 0) {
    renderRecommendationResults();
    return;
  }
  
  // If we are in History mode and a filter is changed, auto-exit History mode
  if (isHistoryMode) {
    switchTab(false);
    return; // switchTab will trigger search if needed
  }

  if (resetOffset) currentOffset = 0;
  isLoadingRoutes = true;

  if (resetOffset) {
    document.getElementById('route-list').innerHTML = '<div style="padding: 20px; text-align: center; opacity: 0.5;">Searching...</div>';
  }

  let f = {
    angles: filterState.angles,
    sortMode: filterState.sortMode,
    sortDesc: filterState.sortDesc,
    secondarySortMode: filterState.secondarySortMode,
    secondarySortDesc: filterState.secondarySortDesc,
    routeName: filterState.routeName,
    setterName: filterState.setterName,
    includeUngraded: filterState.includeUngraded,
    sentFilter: filterState.sentFilter,
    ratedFilter: filterState.ratedFilter
  };

  if (filterState.minGrade !== null) {
    if (filterState.gradeLocked) {
      f.minGrade = filterState.minGrade;
      f.maxGrade = filterState.minGrade;
    } else {
      f.minGrade = filterState.minGrade;
      f.maxGrade = filterState.maxGrade;
    }
  }

  if (filterState.minLength !== null) {
    if (filterState.lengthLocked) {
      f.minLength = filterState.minLength;
      f.maxLength = filterState.minLength;
    } else {
      f.minLength = filterState.minLength;
      f.maxLength = filterState.maxLength;
    }
  }

  dbClient.search(selectedHolds, currentOffset, 50, f, {
    sentUuids: [...logbook.loggedUuids],
    ratedUuids: Object.keys(logbook.ratings)
  });
}

function handleHoldSelect(holdId, role) {
  if (setterController && setterController.isActive) {
    const roleMap = { 'any': 6, 'start': 5, 'middle': 6, 'finish': 7, 'foot': 8 };
    const numericRole = (role === 'any') ? setterController.defaultRole : (roleMap[role] || 6);
    const forceDelete = (role === 'any');
    
    // 1. Check for Ghost Promotion
    if (setterController.isWandActive && setterController.copilot.suggestion && setterController.copilot.suggestion.id == holdId) {
      const s = setterController.copilot.suggestion;
      // Prioritize user-selected role over AI prediction
      const finalRole = (role === 'any') ? s.role : numericRole;
      setterController.state.toggleHold(s.id, finalRole);
      setterController.copilot.suggestion = null; // Clear suggestion
      setterController.suggestionStack = [];
      setterController.suggestionIndex = -1;
      syncSetterToBoard();
      showToast("AI Move Accepted", 500);
      return;
    }

    // 2. Standard Toggling
    setterController.state.toggleHold(holdId, numericRole, forceDelete);
    if (setterController.isWandActive) {
      setterController.suggestionStack = [];
      setterController.suggestionIndex = -1;
    }
    syncSetterToBoard();
    return;
  }




  const existingIndex = selectedHolds.findIndex(h => h.id == holdId);

  if (existingIndex > -1) {
    if (role === 'any') {
      selectedHolds.splice(existingIndex, 1);
    } else {
      selectedHolds[existingIndex].role = role;
    }
  } else {
    selectedHolds.push({ id: holdId, role });
  }

  updateHoldsUI();
  triggerSearch();
}

function updateHoldsUI() {
  document.querySelectorAll('.hold').forEach(h => {
    // Remove only selection-related classes, preserving route-start/middle/etc.
    h.classList.remove('selected-any', 'selected-start', 'selected-middle', 'selected-finish', 'selected-foot');
    
    const s = selectedHolds.find(sel => sel.id == h.dataset.id);
    if (s) {
      h.classList.add(`selected-${s.role}`);
    }
  });
  updateClearButtonsUI();
}

// Touch / Mouse logic for holds
let dragStartTimer = null;
let isPressingHold = false;
let currentHoldElement = null;
let currentPointerId = null;
let radialMenuVisible = false;
let initialTouchDict = { x: 0, y: 0 };

function setupTouchInteractions() {
  const boardOverlay = document.getElementById('board-container');
  const boardImgGroup = document.getElementById('board-images');

  function recenterBoard() {
    boardX = 0;
    boardY = 0;
    boardScale = 1.0;
    boardImgGroup.style.transition = 'transform 0.4s cubic-bezier(0.25, 1, 0.5, 1)';
    boardImgGroup.style.transform = `translate(0px, 0px) scale(1)`;
    setTimeout(() => {
      boardImgGroup.style.transition = 'none';
    }, 400);
  }

  boardOverlay.addEventListener('pointerdown', e => {
    if (e.target.closest('#bottom-sheet')) return;

    // --- Sidebar Closing Logic (Tap Outside) ---
    const filterSidebar = document.getElementById('filter-sidebar');
    const infoSidebar = document.getElementById('info-sidebar');
    if (filterSidebar.classList.contains('open') || infoSidebar.classList.contains('open')) {
      filterSidebar.classList.remove('open');
      infoSidebar.classList.remove('open');
      
      // Prevent the tap from selecting a hold by killing timers
      clearTimeout(dragStartTimer);
      clearTimeout(selectionPendingTimer);
      isPressingHold = false;
      
      // Visual feedback: briefly block interaction
      return;
    }

    activePointerCount++;
    const hold = e.target.closest('.hold');

    // Atomic check for double-tap first
    const now = Date.now();
    // Only allow double-tap if it's a sequential single-finger gesture
    if (now - lastTapTime < 200 && activePointerCount === 1) { 
      e.preventDefault();
      e.stopPropagation();
      isRecentering = true;
      
      if (radialMenuVisible) {
        radialMenu.hide();
        radialMenuVisible = false;
      }
      
      // KILL all pending hold logic and timers IMMEDIATELY
      clearTimeout(selectionPendingTimer);
      clearTimeout(dragStartTimer);
      isPressingHold = false;
      currentHoldElement = null;
      currentPointerId = null;
      
      if (bluetoothController.isConnected && !isLiveMode) {
        if (setterController && setterController.isActive) {
          showToast("Broadcasting Edit...", 1000);
          const frames = setterController.state.getFrames();
          bluetoothController.lightRoute(frames, ledMapping);
        } else if (currentClimb) {
          showToast("Broadcasting Climb...", 1000);
          bluetoothController.lightRoute(currentClimb.frames, ledMapping);
          logbook.addIlluminated(currentClimb.uuid);
        }
      } else if (!bluetoothController.isConnected) {
        handleConnectBoard(false);
      }
      
      lastTapTime = now; 
      return;
    }
    
    lastTapTime = now;
    lastPointerId = e.pointerId;
    isRecentering = false;

    if (!hold) {
      return;
    }
    
    // Set state for the NEW interaction
    isPressingHold = true;
    currentHoldElement = hold;
    currentPointerId = e.pointerId;
    initialTouchDict = { x: e.clientX, y: e.clientY };
    const holdId = hold.dataset.id;
    
    hold.setPointerCapture(e.pointerId);
    
    const holdRect = hold.getBoundingClientRect();
    const holdCenterX = holdRect.left + holdRect.width / 2;
    const holdCenterY = holdRect.top + holdRect.height / 2;
    
    // Timer to distinguish tap from hold-and-drag
    dragStartTimer = setTimeout(() => {
      if (isPressingHold && !isInMapMode && !isRecentering) {
        radialMenuVisible = true;
        hadRadialMenuThisSession = true;
        radialMenu.show(holdCenterX, holdCenterY, holdId);
      }
    }, 200);
  });

  boardOverlay.addEventListener('pointermove', e => {
    if (isPressingHold) {
      if (radialMenuVisible) {
        radialMenu.updateTrack(e.clientX, e.clientY);
      } else {
        const dx = e.clientX - initialTouchDict.x;
        const dy = e.clientY - initialTouchDict.y;
        if (Math.hypot(dx, dy) > 15) {
          clearTimeout(dragStartTimer);
          isPressingHold = false;
          if (currentHoldElement) currentHoldElement.releasePointerCapture(currentPointerId);
        }
      }
    }
  });

  const handleEnd = (e) => {
    if (isPressingHold) {
      activePointerCount = Math.max(0, activePointerCount - 1);
      clearTimeout(dragStartTimer);
      
      if (radialMenuVisible) {
        radialMenu.finishTrack();
        radialMenuVisible = false;
      } else if (!isRecentering && !isInMapMode && currentHoldElement) {
        const targetHoldId = currentHoldElement.dataset.id;
        selectionPendingTimer = setTimeout(() => {
          handleHoldSelect(targetHoldId, 'any');
        }, 220);
      }
      
      if (currentHoldElement) {
        currentHoldElement.releasePointerCapture(currentPointerId);
      }
      
      isPressingHold = false;
      currentHoldElement = null;
    } else {
      activePointerCount = Math.max(0, activePointerCount - 1);
    }
  };

  window.addEventListener('pointerup', handleEnd);
  window.addEventListener('pointercancel', handleEnd);

  // Map Mode Trigger & Capture
  boardOverlay.addEventListener('touchstart', e => {
    if (e.target.closest('#bottom-sheet')) return;
    const touches = e.touches;

    if (touches.length >= 2) {
      if (!isInMapMode && !radialMenuVisible && !hadRadialMenuThisSession) {
        isInMapMode = true;
        hadMapModeThisSession = true;
        // Kill all selection/standard logic immediately
        clearTimeout(dragStartTimer);
        clearTimeout(selectionPendingTimer);
        isPressingHold = false;
        if (currentHoldElement) currentHoldElement.releasePointerCapture(currentPointerId);
      }
    }

    if (touches.length === 1 && !isInMapMode) {
      touchStartX = touches[0].clientX;
      touchStartY = touches[0].clientY;
      hadMapModeThisSession = false;
    }

    // Capture initial state when finger count changes or session begins
    if (isInMapMode) {
      boardImgGroup.style.transition = 'none';
      if (touches.length === 2) {
        const t1 = touches[0];
        const t2 = touches[1];
        const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
        initialDist = Math.max(dist, 40); // Prevent jolt zoom from tiny distances
        initialScale = boardScale;
        const midX = (t1.clientX + t2.clientX) / 2;
        const midY = (t1.clientY + t2.clientY) / 2;
        focalPointX = (midX - boardX) / boardScale;
        focalPointY = (midY - boardY) / boardScale;
      } else if (touches.length === 1) {
        panStartX = touches[0].clientX;
        panStartY = touches[0].clientY;
        initialBoardX = boardX;
        initialBoardY = boardY;
      }
    }
    lastTouchCount = touches.length;
    isElasticSnapping = false; // Reset on every touch start/change
  }, { passive: true });

  boardOverlay.addEventListener('touchmove', e => {
    if (isInMapMode) {
      e.preventDefault();
      const touches = e.touches;

      // If the number of fingers changed during movement, we need to re-anchor
      if (touches.length !== lastTouchCount) {
        if (touches.length === 2) {
          const t1 = touches[0];
          const t2 = touches[1];
          const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
          initialDist = Math.max(dist, 40); // Prevent jolt zoom on re-anchor
          initialScale = boardScale;
          const midX = (t1.clientX + t2.clientX) / 2;
          const midY = (t1.clientY + t2.clientY) / 2;
          focalPointX = (midX - boardX) / boardScale;
          focalPointY = (midY - boardY) / boardScale;
        } else if (touches.length === 1) {
          panStartX = touches[0].clientX;
          panStartY = touches[0].clientY;
          initialBoardX = boardX;
          initialBoardY = boardY;
        }
        lastTouchCount = touches.length;
      }

      if (touches.length === 2) {
        // ZOOM MODE
        const t1 = touches[0];
        const t2 = touches[1];
        const currentDist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
        let newScale = initialScale * (currentDist / initialDist);
        
        // Elastic Threshold: If user zooms out past 1.0 OR by more than 40%
        const scaleRatio = newScale / initialScale;
        if (newScale < 1.0 || scaleRatio < 0.6) {
          isElasticSnapping = true;
        } else {
          isElasticSnapping = false;
        }

        // Allow visual tension (shrink down to 0.5) but snap back on release
        if (newScale < 0.5) newScale = 0.5;
        if (newScale > 4.0) newScale = 4.0;

        const midX = (t1.clientX + t2.clientX) / 2;
        const midY = (t1.clientY + t2.clientY) / 2;

        boardScale = newScale;
        boardX = midX - (focalPointX * boardScale);
        boardY = midY - (focalPointY * boardScale);
      } else if (touches.length === 1) {
        // PAN MODE
        const dx = touches[0].clientX - panStartX;
        const dy = touches[0].clientY - panStartY;
        boardX = initialBoardX + dx;
        boardY = initialBoardY + dy;
      }

      // Clamping (95% overlap rule)
      const rect = boardImgGroup.getBoundingClientRect();
      const winW = window.innerWidth;
      const winH = window.innerHeight;
      const minVisW = rect.width * 0.05;
      const minVisH = rect.height * 0.05;

      if (boardX > winW - minVisW) boardX = winW - minVisW;
      if (boardX < -rect.width + minVisW) boardX = -rect.width + minVisW;
      if (boardY > winH - minVisH) boardY = winH - minVisH;
      if (boardY < -rect.height + minVisH) boardY = -rect.height + minVisH;

      boardImgGroup.style.transform = `translate(${boardX}px, ${boardY}px) scale(${boardScale})`;
    }
  }, { passive: false });

  boardOverlay.addEventListener('touchend', e => {
    if (e.touches.length === 0) {
      // Exit Map Mode only when all fingers are lifted
      if (isInMapMode) {
        // Trigger recenter if elastic threshold was met, OR if close to center
        if (isElasticSnapping || (Math.abs(boardX) < 40 && Math.abs(boardY) < 40 && boardScale < 1.05)) {
          recenterBoard();
        }
      }
    }

    if (e.changedTouches.length > 0 && !hadMapModeThisSession && !isInMapMode && !hadRadialMenuThisSession) {
      const touchEndX = e.changedTouches[0].clientX;
      const touchEndY = e.changedTouches[0].clientY;
      const dx = touchEndX - touchStartX;
      const dy = touchEndY - touchStartY;

      if (Math.abs(dx) > 40 || Math.abs(dy) > 40) {
        if (setterController && setterController.isActive) {
          // GESTURE NAVIGATION
          if (Math.abs(dx) > Math.abs(dy)) {
            // Horizontal: Undo/Redo/Accept
            if (dx < 0) { // Right-to-Left: FORWARD
              if (setterController.isWandActive && setterController.copilot.suggestion) {
                 const s = setterController.copilot.suggestion;
                 setterController.state.toggleHold(s.id, s.role);
                 
                 // Clear tower history on acceptance to branch fresh
                 setterController.suggestionStack = [];
                 setterController.suggestionIndex = -1;
                 setterController.copilot.suggestion = null;
                 
                 syncSetterToBoard();
                 showToast("AI Move Accepted", 500);
              } else if (setterController.state.redo()) {
                 syncSetterToBoard();
                 showToast("Redo", 500);
              }
            } else { // Left-to-Right: BACK
              if (setterController.state.undo()) {
                 syncSetterToBoard();
                 showToast("Undo", 500);
              }
            }
          } else {
            // Vertical: Suggestion Tower
            if (setterController.isWandActive) {
               if (dy > 0) { // Top-to-Bottom: NEW
                 setterController.nextSuggestion(1);
               } else { // Bottom-to-Top: OLD
                 setterController.nextSuggestion(-1);
               }
            }
          }

        } else {
          // DISCOVERY Navigation
          if (Math.abs(dx) > Math.abs(dy)) {
            if (dx > 0) navigateRoutes(-1); // Back
            else navigateRoutes(1); // Forward
          }
        }
      }
    }

    // RESET GUARDS AT THE VERY END
    if (e.touches.length === 0) {
      isInMapMode = false;
      hadMapModeThisSession = false;
      hadRadialMenuThisSession = false;
      lastTouchCount = 0;
    }
  });
}

function updateActiveClimbUI(r) {
  if (!r) return;
  document.getElementById('climb-name').innerText = r.name;

  const displayGrade = r.grade || '--/--';
  const gradeStr = `<span style="margin: 0 12px; opacity: 0.5">•</span><span style="font-weight: 600;">${displayGrade}</span>`;
  const angleStr = (r.angle !== 'Any' && r.angle !== null) ? `<span style="margin: 0 12px; opacity: 0.5">@</span><span>${r.angle}°</span>` : '';
  document.getElementById('climb-setter').innerHTML = `
    <span style="display: inline-flex; align-items: center; justify-content: center; max-width: 100%;">
      <span style="opacity: 0.8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 130px;">by ${r.setter}</span>
      <span style="display: flex; align-items: center; flex-shrink: 0;">${gradeStr}${angleStr}</span>
    </span>
  `;

  const rating = r.rating ? r.rating.toFixed(1) : '0.0';
  const ascents = r.ascents ? r.ascents.toLocaleString() : '0';
  if (currentRoutes.length === 0) return;

  // Snap board back to center on route change
  document.getElementById('climb-stats-header').innerHTML = `
    <span>⭐ ${rating}</span>
    <span>👤 ${ascents}</span>
    <span>📐 ${r.hold_count} holds</span>
  `;

  const descElem = document.getElementById('climb-description');
  if (r.description && r.description.trim()) {
    descElem.innerText = `Description: ${r.description}`;
  } else {
    descElem.innerText = '';
  }

  // Highlight in list
  const list = document.getElementById('route-list');
  if (list) {
    Array.from(list.children).forEach((child, idx) => {
      if (idx === currentRouteIndex) {
        child.classList.add('selected');
        // Manual scrollTo ensures we don't trigger a full-page layout shift
        const topPos = child.offsetTop;
        const bottomPos = topPos + child.offsetHeight;
        const viewTop = list.scrollTop;
        
        // Use the actual visible height of the list (respecting bottom-sheet translation)
        const listRect = list.getBoundingClientRect();
        const visibleHeight = Math.max(0, window.innerHeight - listRect.top);
        const viewBottom = viewTop + visibleHeight;

        // If it's the first item, always snap to the absolute top
        if (currentRouteIndex === 0) {
          list.scrollTo({ top: 0, behavior: 'smooth' });
        } else if (topPos < viewTop) {
          // --- MOVING UP (BACKWARDS) ---
          // Snap bottom of item to bottom of visible area to reveal previous items above
          if (visibleHeight > (child.offsetHeight + 80)) {
            list.scrollTo({ top: Math.max(0, bottomPos - visibleHeight + 40), behavior: 'smooth' });
          } else {
            // Unless sheet is too small, then snap top to top to show title
            list.scrollTo({ top: topPos, behavior: 'smooth' });
          }
        } else if (bottomPos > (viewBottom - 40)) { 
          // --- MOVING DOWN (FORWARDS) ---
          // Snap top of item to top of visible area to reveal upcoming items below
          list.scrollTo({ top: topPos, behavior: 'smooth' });
        }
      } else {
        child.classList.remove('selected');
      }
    });
  }
}

function navigateRoutes(direction) {
  // Reset horizontal board offset when navigating
  boardX = 0;
  const boardImgGroup = document.getElementById('board-images');
  boardImgGroup.style.transition = 'transform 0.4s cubic-bezier(0.25, 1, 0.5, 1)';
  boardImgGroup.style.transform = `translateX(0px)`;
  setTimeout(() => { boardImgGroup.style.transition = 'none'; }, 400);

  currentRouteIndex += direction;
  if (currentRouteIndex < 0) currentRouteIndex = currentRoutes.length - 1;
  if (currentRouteIndex >= currentRoutes.length) currentRouteIndex = 0;

  const r = currentRoutes[currentRouteIndex];
  renderRoute(r);
  updateActiveClimbUI(r);

  currentClimb = r; // Store for auto-relighting

  if (bluetoothController && bluetoothController.isConnected && isLiveMode) {
    bluetoothController.lightRoute(r.frames, ledMapping);
    logbook.addIlluminated(r.uuid);
  }
}

function renderRoute(route) {
  // Clear any existing rings
  document.querySelectorAll('.hold').forEach(h => {
    h.classList.remove('route-start', 'route-middle', 'route-finish', 'route-foot', 'ghost');
  });

  if (!route) return;

  const frames = route.frames || '';
  const pieces = frames.split('p');
  pieces.forEach(frame => {
    if (!frame) return;
    const [placement, role] = frame.split('r');

    let roleName = '';
    if (role == '5') roleName = 'start';
    if (role == '6') roleName = 'middle';
    if (role == '7') roleName = 'finish';
    if (role == '8') roleName = 'foot';

    if (roleName) {
      const holdElem = document.querySelector(`.hold[data-id="${placement}"]`);
      if (holdElem) holdElem.classList.add(`route-${roleName}`);
    }
  });

  // Handle suggestion (Ghost Hold)
  if (route.suggestion) {
    const s = route.suggestion;
    const holdElem = document.querySelector(`.hold[data-id="${s.id}"]`);
    if (holdElem) {
      holdElem.classList.add('ghost');
      const roleName = (s.role == 5 ? 'start' : s.role == 7 ? 'finish' : s.role == 8 ? 'foot' : 'middle');
      holdElem.classList.add(`route-${roleName}`);
    }
  }
}


function setupScrollLoading() {
  const list = document.getElementById('route-list');
  list.addEventListener('scroll', () => {
    if (isLoadingRoutes) return;

    if (list.scrollTop + list.clientHeight >= list.scrollHeight - 400) {
      if (currentRoutes.length < totalResultsCount) {
        currentOffset = currentRoutes.length;
        triggerSearch(false);
      }
    }
  });
}

function updateFilterDropdowns() {
  const angleContainer = document.getElementById('angle-toggles');
  if (angleContainer) {
    angleContainer.innerHTML = '';
    systemAngles.forEach(a => {
      const btn = document.createElement('button');
      btn.innerText = `${a}°`;
      btn.onclick = () => {
        btn.classList.toggle('active');
        if (btn.classList.contains('active')) filterState.angles.push(a);
        else filterState.angles = filterState.angles.filter(ang => ang !== a);
        triggerSearch();
      };
      angleContainer.appendChild(btn);
    });
  }

  const minSel = document.getElementById('min-grade-select');
  const maxSel = document.getElementById('max-grade-select');
  if (minSel && maxSel) {
    minSel.innerHTML = '';
    maxSel.innerHTML = '';
    systemGrades.forEach(g => {
      const opt1 = document.createElement('option'); opt1.value = g.id; opt1.innerText = g.name;
      const opt2 = document.createElement('option'); opt2.value = g.id; opt2.innerText = g.name;
      minSel.appendChild(opt1);
      maxSel.appendChild(opt2);
    });

    if (systemGrades.length > 0) {
      minSel.value = systemGrades[0].id;
      maxSel.value = systemGrades[systemGrades.length - 1].id;
      filterState.minGrade = parseInt(minSel.value);
      filterState.maxGrade = parseInt(maxSel.value);
    }
  }

  const minLenSel = document.getElementById('min-length-select');
  const maxLenSel = document.getElementById('max-length-select');
  if (minLenSel && maxLenSel) {
    minLenSel.innerHTML = '';
    maxLenSel.innerHTML = '';
    for (let i = 2; i <= 40; i++) {
      const opt1 = document.createElement('option'); opt1.value = i; opt1.innerText = `${i} Holds`;
      const opt2 = document.createElement('option'); opt2.value = i; opt2.innerText = `${i} Holds`;
      minLenSel.appendChild(opt1);
      maxLenSel.appendChild(opt2);
    }
    minLenSel.value = 2;
    maxLenSel.value = 40;
  }
}

function initFilterSidebar() {
  const routeInput = document.getElementById('route-name-input');
  const setterInput = document.getElementById('setter-name-input');

  let searchTimeout;
  const handleTextSearch = () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      filterState.routeName = routeInput.value.trim();
      filterState.setterName = setterInput.value.trim();
      triggerSearch();
    }, 350); // Small debounce for smooth typing
  };

  routeInput.addEventListener('input', handleTextSearch);
  setterInput.addEventListener('input', handleTextSearch);

  updateFilterDropdowns();

  const minSel = document.getElementById('min-grade-select');
  const maxSel = document.getElementById('max-grade-select');
  const padlock = document.getElementById('padlock-btn');
  const padlockImg = document.getElementById('padlock-img');
  padlock.onclick = () => {
    filterState.gradeLocked = !filterState.gradeLocked;
    padlockImg.src = filterState.gradeLocked ? '/icons/lock.svg' : '/icons/unlock.svg';
    padlock.classList.toggle('unlocked', !filterState.gradeLocked);
    maxSel.disabled = filterState.gradeLocked;
    triggerSearch();
  };

  minSel.onchange = () => {
    filterState.minGrade = parseInt(minSel.value);
    triggerSearch();
  };
  maxSel.onchange = () => {
    filterState.maxGrade = parseInt(maxSel.value);
    triggerSearch();
  };

  const minLenSel = document.getElementById('min-length-select');
  const maxLenSel = document.getElementById('max-length-select');
  const lenPadlock = document.getElementById('length-padlock-btn');
  const lenPadlockImg = document.getElementById('length-padlock-img');
  lenPadlock.onclick = () => {
    filterState.lengthLocked = !filterState.lengthLocked;
    lenPadlockImg.src = filterState.lengthLocked ? '/icons/lock.svg' : '/icons/unlock.svg';
    lenPadlock.classList.toggle('unlocked', !filterState.lengthLocked);
    maxLenSel.disabled = filterState.lengthLocked;
    triggerSearch();
  };

  minLenSel.onchange = () => {
    filterState.minLength = parseInt(minLenSel.value);
    triggerSearch();
  };
  maxLenSel.onchange = () => {
    filterState.maxLength = parseInt(maxLenSel.value);
    triggerSearch();
  };

  const ungradedCb = document.getElementById('include-ungraded-cb');
  ungradedCb.onchange = () => {
    filterState.includeUngraded = ungradedCb.checked;
    triggerSearch();
  };

  const sidebar = document.getElementById('filter-sidebar');
  const infoSidebar = document.getElementById('info-sidebar');
  const infoToggle = document.getElementById('info-toggle');

  // Onboarding: Pulse info button for new users
  if (!localStorage.getItem('boardle_tutorial_seen')) {
    infoToggle.classList.add('pulsing');
  }

  // Restore Hide "i" preference
  const isInfoHidden = localStorage.getItem('boardle_hide_info') === 'true';
  const hideInfoCb = document.getElementById('hide-info-btn-cb');
  if (isInfoHidden) {
    infoToggle.classList.add('hidden-pref');
    if (hideInfoCb) hideInfoCb.checked = true;
  }

  if (hideInfoCb) {
    hideInfoCb.onchange = () => {
      const hidden = hideInfoCb.checked;
      infoToggle.classList.toggle('hidden-pref', hidden);
      localStorage.setItem('boardle_hide_info', hidden ? 'true' : 'false');
    };
  }

  infoToggle.onclick = () => {
    infoSidebar.style.transform = '';
    infoSidebar.classList.add('open');
    // Clear onboarding pulse
    infoToggle.classList.remove('pulsing');
    localStorage.setItem('boardle_tutorial_seen', 'true');
  };

  document.getElementById('info-close').onclick = () => {
    infoSidebar.classList.remove('open');
  };

  document.getElementById('sidebar-toggle').onclick = () => {
    sidebar.style.transform = ''; // Ensure clean slate when opening
    sidebar.classList.add('open');
  };
  document.getElementById('sidebar-close').onclick = () => {
    sidebar.classList.remove('open');
    setTimeout(() => {
      if (!sidebar.classList.contains('open')) sidebar.style.transform = '';
    }, 300);
  };

  // Swipe-to-close logic for Filter Sidebar (Right-side, swipe RIGHT to close)
  let sidebarStartX = 0;
  let sidebarCurrentDx = 0;

  sidebar.addEventListener('touchstart', (e) => {
    sidebarStartX = e.touches[0].clientX;
    sidebar.style.transition = 'none'; // Disable transition during drag
  }, { passive: true });

  sidebar.addEventListener('touchmove', (e) => {
    const x = e.touches[0].clientX;
    sidebarCurrentDx = Math.max(0, x - sidebarStartX); // Only allow swiping to the right
    if (sidebarCurrentDx > 0) {
      sidebar.style.transform = `translateX(${sidebarCurrentDx}px)`;
    }
  }, { passive: true });

  sidebar.addEventListener('touchend', () => {
    sidebar.style.transition = ''; // Restore CSS transition
    if (sidebarCurrentDx > 80) {
      sidebar.classList.remove('open');
      setTimeout(() => {
        if (!sidebar.classList.contains('open')) sidebar.style.transform = '';
      }, 300);
    } else {
      sidebar.style.transform = 'translateX(0)';
    }
    sidebarCurrentDx = 0;
  }, { passive: true });

  // Swipe-to-close logic for Info Sidebar (Left-side, swipe LEFT to close)
  let infoStartX = 0;
  let infoCurrentDx = 0;

  infoSidebar.addEventListener('touchstart', (e) => {
    infoStartX = e.touches[0].clientX;
    infoSidebar.style.transition = 'none';
  }, { passive: true });

  infoSidebar.addEventListener('touchmove', (e) => {
    const x = e.touches[0].clientX;
    infoCurrentDx = Math.min(0, x - infoStartX); // Only allow swiping to the left
    if (infoCurrentDx < 0) {
      infoSidebar.style.transform = `translateX(${infoCurrentDx}px)`;
    }
  }, { passive: true });

  infoSidebar.addEventListener('touchend', () => {
    infoSidebar.style.transition = '';
    if (infoCurrentDx < -80) {
      infoSidebar.classList.remove('open');
      setTimeout(() => {
        if (!infoSidebar.classList.contains('open')) infoSidebar.style.transform = '';
      }, 300);
    } else {
      infoSidebar.style.transform = 'translateX(0)';
    }
    infoCurrentDx = 0;
  }, { passive: true });

  const sortSel = document.getElementById('order-select');
  const secContainer = document.getElementById('secondary-order-container');
  const revBtn = document.getElementById('order-reverse-btn');

  const updateMainReverseButtonUI = () => {
    if (filterState.sortMode === 'random') {
      revBtn.innerText = '↻';
    } else {
      revBtn.innerText = filterState.sortDesc ? '↑' : '↓';
    }
  };

  sortSel.onchange = () => {
    filterState.sortMode = sortSel.value;
    if (filterState.sortMode === 'random') {
      secContainer.classList.add('disabled');
    } else {
      secContainer.classList.remove('disabled');
    }
    updateMainReverseButtonUI();
    triggerSearch();
  };

  revBtn.onclick = () => {
    filterState.sortDesc = !filterState.sortDesc;
    updateMainReverseButtonUI();
    triggerSearch();
  };

  const secSortSel = document.getElementById('secondary-order-select');
  const secRevBtn = document.getElementById('secondary-order-reverse-btn');

  const updateSecReverseButtonUI = () => {
    if (filterState.secondarySortMode === 'random') {
      secRevBtn.innerText = '↻';
    } else {
      secRevBtn.innerText = filterState.secondarySortDesc ? '↑' : '↓';
    }
  };

  secSortSel.onchange = () => {
    filterState.secondarySortMode = secSortSel.value;
    updateSecReverseButtonUI();
    triggerSearch();
  };

  secRevBtn.onclick = () => {
    filterState.secondarySortDesc = !filterState.secondarySortDesc;
    updateSecReverseButtonUI();
    triggerSearch();
  };
  // Set initial select values based on default filterState
  sortSel.value = filterState.sortMode;
  secSortSel.value = filterState.secondarySortMode;

  if (filterState.sortMode === 'random') {
    secContainer.classList.add('disabled');
  } else {
    secContainer.classList.remove('disabled');
  }

  updateMainReverseButtonUI();
  updateSecReverseButtonUI();

  // Status Toggles (Sent / Rated)
  const setupStatusToggle = (containerId, stateKey) => {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.querySelectorAll('button').forEach(btn => {
      btn.onclick = () => {
        container.querySelectorAll('button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        filterState[stateKey] = btn.dataset.value;
        triggerSearch();
      };
    });
  };

  setupStatusToggle('sent-toggles', 'sentFilter');
  setupStatusToggle('rated-toggles', 'ratedFilter');
}

function handleRoutesUpdate(payload) {
  isLoadingRoutes = false;

  const list = document.getElementById('route-list');
  const countBadge = document.getElementById('route-count');

  if (payload.isUnsynced) {
    list.innerHTML = `
      <div style="padding: 40px 20px; text-align: center; color: rgba(255,255,255,0.5);">
        <div style="font-size: 3rem; margin-bottom: 20px;">🧗‍♂️</div>
        <h2 style="color: white; margin-bottom: 10px;">Welcome to Boardle!</h2>
        <p style="font-size: 0.95rem; line-height: 1.5; margin-bottom: 20px;">
          Your local database is currently empty. To get started, sync with the official board data.
        </p>
        <button onclick="document.getElementById('sync-open-btn').click()" style="background: #3b82f6; color: white; border: none; padding: 12px 24px; border-radius: 8px; font-weight: bold; cursor: pointer;">
          Sync Now
        </button>
      </div>
    `;
    if (countBadge) countBadge.textContent = '0 routes found';
    return;
  }

  if (!payload || !payload.routes) return;

  totalResultsCount = payload.totalCount;
  document.getElementById('route-count').innerText = `${totalResultsCount.toLocaleString()} routes found`;

  if (payload.offset === 0) {
    currentRoutes = payload.routes;
    list.innerHTML = '';

    // If search returns zero results, reset the main UI to default
    if (currentRoutes.length === 0) {
      document.getElementById('climb-name').innerText = 'Select a Climb';
      document.getElementById('climb-setter').innerHTML = 'Tension Board';
      document.getElementById('climb-description').innerText = '';
      renderRoute(null);
      currentRouteIndex = -1;
      currentClimb = null;
    }
  } else {
    currentRoutes = currentRoutes.concat(payload.routes);
  }

  payload.routes.forEach((r, idx) => {
    const routeContainer = document.createElement('div');
    routeContainer.className = 'route-item';
    if (r.isSource && !isHistoryMode) routeContainer.classList.add('is-source');
    if (logbook.has(r.uuid)) routeContainer.classList.add('is-climbed');

    // Background Trays
    const leftTray = document.createElement('div');
    leftTray.className = 'route-item-actions-left';
    leftTray.innerHTML = `<span>${logbook.has(r.uuid) ? 'Unlog Send' : 'Log Send'}</span>`;

    const rightTray = document.createElement('div');
    rightTray.className = 'route-item-actions-right';
    rightTray.innerHTML = `
      <div class="rating-stars-container">
        <div class="rating-star" data-star="1"></div>
        <div class="rating-star" data-star="2"></div>
        <div class="rating-star" data-star="3"></div>
      </div>
    `;

    const contentDiv = document.createElement('div');
    contentDiv.className = 'route-item-content';

    const displayGrade = r.grade || '--/--';
    const gradePill = `<span style="margin: 0 10px; opacity: 0.4">•</span><strong style="color: #fff;">${displayGrade}</strong>`;
    const anglePill = (r.angle !== 'Any' && r.angle !== null) ? `<span style="margin: 0 10px; opacity: 0.4">@</span><span style="color: rgba(255,255,255,0.8)">${r.angle}°</span>` : '';

    const rating = r.rating ? r.rating.toFixed(1) : '0.0';
    const ascents = r.ascents ? r.ascents.toLocaleString() : '0';
    const personalRating = logbook.getRating(r.uuid);
    let miniStarsHtml = '';
    if (personalRating > 0) {
      miniStarsHtml = `<div class="personal-rating-indicator">`;
      for (let i = 1; i <= 3; i++) {
        let cls = 'mini-star';
        if (personalRating >= i) cls += ' filled';
        else if (personalRating > i - 1) cls += ' half';
        miniStarsHtml += `<div class="${cls}"></div>`;
      }
      miniStarsHtml += `</div>`;
    }

    contentDiv.innerHTML = `
      <div style="margin-bottom: 4px;">
        <strong style="font-size: 1.15rem; letter-spacing: -0.3px;">${r.name}</strong>
      </div>
      <div style="color: rgba(255,255,255,0.5); font-size: 0.85rem; display: flex; align-items: center; margin-bottom: 6px;">
        <span>by ${r.setter}</span>
        ${gradePill}
        ${anglePill}
      </div>
      <div style="color: rgba(255,255,255,0.4); font-size: 0.8rem; display: flex; align-items: center; gap: 12px;">
        <span>⭐ ${rating}</span>
        <span>👤 ${ascents}</span>
        <span>📐 ${r.hold_count} holds</span>
      </div>
      ${miniStarsHtml}
    `;

    const absoluteIdx = payload.offset + idx;

    contentDiv.addEventListener('click', () => {
      currentRouteIndex = absoluteIdx;
      currentClimb = r;
      renderRoute(r);
      updateActiveClimbUI(r);
      
      // Sync to physical board
      if (bluetoothController && bluetoothController.isConnected && isLiveMode) {
        bluetoothController.lightRoute(r.frames, ledMapping);
        logbook.addIlluminated(r.uuid);
      }
    });

    // --- Recommendation Long Press ---
    let pressTimer;
    let startCoords = { x: 0, y: 0 };
    
    const startPress = (e) => {
      const clientX = e.type === 'touchstart' ? e.touches[0].clientX : e.clientX;
      const clientY = e.type === 'touchstart' ? e.touches[0].clientY : e.clientY;
      startCoords = { x: clientX, y: clientY };
      
      contentDiv.classList.add('long-pressing');
      
      pressTimer = setTimeout(() => {
        if (navigator.vibrate) navigator.vibrate(50);
        contentDiv.classList.remove('long-pressing');
        
        // --- Self-Exit Shortcut ---
        // If we are in recommendation mode and the user holds the SOURCE climb, treat as HOME
        if (recommendationStack.length > 0) {
          const currentSource = recommendationStack[recommendationStack.length - 1].sourceClimb;
          if (r.uuid === currentSource.uuid) {
            handleRecHome();
            return;
          }
        }

        // Trigger Pop Animation on list
        const list = document.getElementById('route-list');
        if (list) {
          list.classList.remove('rec-pop');
          void list.offsetWidth; // Force reflow
          list.classList.add('rec-pop');
        }
        
        handleTriggerRecommendation(r);
      }, 600);
    };
    
    const checkDrift = (e) => {
      if (!pressTimer) return;
      const clientX = e.type === 'touchmove' ? e.touches[0].clientX : e.clientX;
      const clientY = e.type === 'touchmove' ? e.touches[0].clientY : e.clientY;
      
      const dx = Math.abs(clientX - startCoords.x);
      const dy = Math.abs(clientY - startCoords.y);
      
      if (dx > 5 || dy > 5) {
        cancelPress();
      }
    };
    
    const cancelPress = () => {
      clearTimeout(pressTimer);
      pressTimer = null;
      contentDiv.classList.remove('long-pressing');
    };

    contentDiv.addEventListener('mousedown', startPress);
    contentDiv.addEventListener('mousemove', checkDrift);
    contentDiv.addEventListener('mouseup', cancelPress);
    contentDiv.addEventListener('mouseleave', cancelPress);
    
    contentDiv.addEventListener('touchstart', (e) => {
      startPress(e);
    }, { passive: true });
    
    contentDiv.addEventListener('touchmove', (e) => {
      checkDrift(e);
    }, { passive: true });
    
    contentDiv.addEventListener('touchend', cancelPress);
    contentDiv.addEventListener('touchcancel', cancelPress);

    // Swipe logic
    let startX = 0;
    let startY = 0;
    let currentX = 0;
    let swipeLock = false;
    let scrollLock = false;

    contentDiv.addEventListener('touchstart', (e) => {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      contentDiv.style.transition = 'none';
      swipeLock = false;
      scrollLock = false;
    }, { passive: true });

    contentDiv.addEventListener('touchmove', (e) => {
      currentX = e.touches[0].clientX;
      const currentY = e.touches[0].clientY;
      const dx = currentX - startX;
      const dy = currentY - startY;

      // Intent detection
      if (!swipeLock && !scrollLock) {
        if (Math.abs(dx) > 8) {
          swipeLock = true;
        } else if (Math.abs(dy) > 8) {
          scrollLock = true;
        }
      }

      if (swipeLock) {
        // Block browser vertical scroll
        if (e.cancelable) e.preventDefault();
        
        leftTray.style.opacity = '1';
        rightTray.style.opacity = '1';

        let finalDx = dx;
        // Logic for both directions
        if (finalDx > 0) {
          // Swipe Right (Log)
          finalDx = Math.min(finalDx, 150);
          leftTray.style.display = 'flex';
          rightTray.style.display = 'none';
        } else if (finalDx < 0) {
          // Swipe Left (Rate)
          finalDx = Math.max(finalDx, -200); // Plenty for 3.0 rating
          rightTray.style.display = 'flex';
          leftTray.style.display = 'none';
          
          // Magnetic Stars Reveal logic
          const swipeDist = Math.abs(finalDx);
          let rawRating = (swipeDist - 40) / 50;
          // Snap to 0.5 steps
          const snappedRating = Math.max(0, Math.min(3, Math.round(rawRating * 2) / 2));
          
          const stars = rightTray.querySelectorAll('.rating-star');
          stars.forEach((s, i) => {
            s.classList.remove('filled', 'half');
            const starVal = i + 1;
            if (snappedRating >= starVal) {
              s.classList.add('filled');
            } else if (snappedRating > starVal - 1) {
              s.classList.add('half');
            }
          });
          
          // Temporary display of snapped rating if needed, but stars are visual enough
        } else {
          leftTray.style.display = 'none';
          rightTray.style.display = 'none';
        }

        contentDiv.style.transform = `translateX(${finalDx}px)`;
      }
    }, { passive: false });

    contentDiv.addEventListener('touchend', () => {
      contentDiv.style.transition = 'transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
      if (swipeLock) {
        const dx = currentX - startX;
        if (dx > 100) {
          const isLogged = logbook.toggle(r.uuid);
          if (isLogged && navigator.vibrate) navigator.vibrate(15); // Satisfying click
          routeContainer.classList.toggle('is-climbed', isLogged);
          leftTray.innerHTML = `<span>${isLogged ? 'Unlog Send' : 'Log Send'}</span>`;
        } else if (dx < -10) { // Small threshold to avoid accidental taps
          // Final Snap for Rating
          const swipeDist = Math.abs(dx);
          let rawRating = (swipeDist - 40) / 50;
          let finalRating = Math.round(rawRating * 2) / 2;
          finalRating = Math.max(0, Math.min(3, finalRating));
          
          logbook.setRating(r.uuid, finalRating);
          
          // Refresh this item's content to show/hide mini-stars
          const existingIndicator = contentDiv.querySelector('.personal-rating-indicator');
          if (existingIndicator) existingIndicator.remove();
          
          if (finalRating > 0) {
            let newMiniStarsHtml = `<div class="personal-rating-indicator">`;
            for (let i = 1; i <= 3; i++) {
              let cls = 'mini-star';
              if (finalRating >= i) cls += ' filled';
              else if (finalRating > i - 1) cls += ' half';
              newMiniStarsHtml += `<div class="${cls}"></div>`;
            }
            newMiniStarsHtml += `</div>`;
            contentDiv.insertAdjacentHTML('beforeend', newMiniStarsHtml);
          }

          // Also update header if this is the active climb
          if (currentRouteIndex === absoluteIdx) {
            navigateRoutes(0);
          }
        }
      }

      contentDiv.style.transform = '';
      leftTray.style.opacity = '0';
      rightTray.style.opacity = '0';
      currentX = 0;
      startX = 0;
      swipeLock = false;
      scrollLock = false;
    });

    routeContainer.appendChild(leftTray);
    routeContainer.appendChild(rightTray);
    routeContainer.appendChild(contentDiv);
    list.appendChild(routeContainer);
  });

  if (payload.offset === 0 && currentRoutes.length > 0) {
    currentRouteIndex = payload.restoreIndex !== undefined ? payload.restoreIndex : 0;
    navigateRoutes(0);
    // Let the user decide when to collapse it
  }

  if (bottomSheet) bottomSheet.updatePosition();
}

function updateIndicatorUI() {
  const bsp = document.getElementById('bottom-sheet-pill');
  const sp = document.getElementById('setter-pill');
  if (!bsp) return;

  const pills = [bsp];
  if (sp) pills.push(sp);

  pills.forEach(p => {
    p.classList.remove('disconnected', 'connected', 'passive', 'live');
    p.classList.add(connectionStatus);
    p.classList.add(isLiveMode ? 'live' : 'passive');
  });
}

async function handleConnectBoard(isManual = true) {
  if (isConnecting) return;
  isConnecting = true;
  
  try {
    const btBtn = document.getElementById('bluetooth-connect-btn');
    
    if (isManual && !navigator.bluetooth) {
      alert("Bluetooth Not Supported\n\nWeb Bluetooth is not supported on this browser. On iOS, you must use a bridge app like 'WebBLE' or 'Bluefy'. On Desktop, use Chrome or Edge.");
      return;
    }

    if (!isMockBT && !isManual && !bluetoothController.device) {
      showToast("Connect via Menu");
      return;
    }

    const onDisconnect = () => {
      connectionStatus = 'disconnected';
      updateIndicatorUI();

      if (btBtn) {
        btBtn.innerHTML = '<span style="font-size: 1.2rem;">⚡</span> Connect Board';
        btBtn.style.background = 'rgba(59, 130, 246, 0.2)';
        btBtn.style.color = '#3b82f6';
        btBtn.style.borderColor = 'rgba(59, 130, 246, 0.5)';
      }
      const modeLabel = isLiveMode ? "Live" : "Passive";
      showToast(`🔴 Disconnected ${modeLabel}`, 3000);
    };

    if (isManual && bluetoothController.isConnected) {
      await bluetoothController.disconnect();
      onDisconnect();
      return;
    }

    showToast('Connecting...');
    if (btBtn && isManual) btBtn.innerHTML = '<span style="font-size: 1.2rem;">⏳</span> Linking...';

    const result = isMockBT ? true : await bluetoothController.connect(onDisconnect, isManual);
    
    if (result === true) {
      console.log("Connection Success (Mock:", isMockBT, ")");
      connectionStatus = 'connected';
      if (isMockBT) bluetoothController.isConnected = true; 
      updateIndicatorUI();

      if (btBtn) {
        btBtn.innerHTML = '<span style="font-size: 1.2rem;">🔴</span> Disconnect Board';
        btBtn.style.background = 'rgba(239, 68, 68, 0.2)';
        btBtn.style.color = '#ef4444';
        btBtn.style.borderColor = 'rgba(239, 68, 68, 0.5)';
      }
      const modeLabel = isLiveMode ? "Live" : "Passive";
      showToast(`🟢 Connected ${modeLabel}`, 2000);
      if (isLiveMode) {
        if (setterController && setterController.isActive) {
          bluetoothController.lightRoute(setterController.state.getFrames(), ledMapping);
        } else if (currentClimb) {
          bluetoothController.lightRoute(currentClimb.frames, ledMapping);
          logbook.addIlluminated(currentClimb.uuid);
        }
      }
    } else {
      // Short & Sweet Diagnostic Feedback
      if (result === "USER_CANCELLED") {
        // Silence is golden
      } else if (result === "DISCOVERY_FAILED") {
        if (isManual) {
          showToast("No board found.");
        } else {
          showToast("Connect via Menu");
        }
      } else if (result === "GATT_CONNECTION_FAILED") {
        showToast("Link dropped.");
      } else if (result === "SERVICE_NOT_FOUND") {
        showToast("Incorrect link.");
      } else if (result === "BLUETOOTH_OFF") {
        showToast("Bluetooth off.");
      } else {
        showToast("Connection Failed");
      }

      if (isManual && btBtn) {
        btBtn.innerHTML = '<span style="font-size: 1.2rem;">❌</span> Failed';
        setTimeout(() => {
          if (!bluetoothController.isConnected) {
            btBtn.innerHTML = '<span style="font-size: 1.2rem;">⚡</span> Connect Board';
          }
        }, 3000);
      }
    }
  } catch (e) {
    console.error("Connection error:", e);
    isConnecting = false;
  } finally {
    isConnecting = false;
  }
}

const toast = document.getElementById('toast');
let toastTimer;

function showToast(message, duration = 2000) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.innerText = message;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), duration);
}

/**
 * --- RECOMMENDATION ENGINE UI LOGIC ---
 */

async function handleTriggerRecommendation(climb) {
  if (isHistoryMode) {
    switchTab(false);
  }
  
  showToast('Finding similar climbs...', 1000);
  
  try {
    const recommendations = await dbClient.getSimilarClimbs(climb.uuid);
    
    if (recommendations && recommendations.length > 0 && recommendations[0].isError) {
      showToast('Sim DB Error: ' + recommendations[0].message, 3000);
      return;
    }
    
    if (!recommendations || recommendations.length === 0) {
      showToast('No recommendations found');
      return;
    }

    // Push to stack
    recommendationStack.push({
      sourceClimb: climb,
      results: recommendations
    });

    renderRecommendationResults();
  } catch (e) {
    console.error('Recommendation error:', e);
    showToast('Error loading recommendations');
  }
}

async function renderRecommendationResults() {
  const stackTop = recommendationStack[recommendationStack.length - 1];
  if (!stackTop) {
    exitRecommendationMode();
    return;
  }

  const { sourceClimb, results } = stackTop;
  
  // Update UI Status Bar
  document.getElementById('normal-status').classList.add('hidden');
  document.getElementById('recommendation-status').classList.remove('hidden');
  document.getElementById('rec-title').innerText = `Similar to ${sourceClimb.name}`;
  
  // Update Filter toggle state
  const filterBtn = document.getElementById('rec-filter-btn');
  filterBtn.classList.toggle('active', !ignoreFiltersInRecommendations);
  filterBtn.innerText = ignoreFiltersInRecommendations ? 'Filters: OFF' : 'Filters: ON';

  // Apply optional filtering
  let finalClimbs = results; // results are already full climb objects now
  if (!ignoreFiltersInRecommendations) {
    finalClimbs = results.filter(c => {
      // Grade & Ungraded Logic
      const hasGrade = c.difficulty !== null && c.difficulty !== undefined;
      if (!hasGrade) {
        if (!filterState.includeUngraded) return false;
      } else {
        if (filterState.minGrade !== null && c.difficulty < filterState.minGrade) return false;
        if (filterState.maxGrade !== null && c.difficulty > filterState.maxGrade) return false;
      }
      
      // Angle filter
      if (filterState.angles.length > 0 && !filterState.angles.includes(parseInt(c.angle))) return false;
      
      // Hold Selection filter (Spatial Filtering)
      if (selectedHolds.length > 0) {
        const frames = c.frames || '';
        const hasAllHolds = selectedHolds.every(sh => frames.includes(`p${sh.id}r`));
        if (!hasAllHolds) return false;
      }
      
      // Status Filters (Sent / Rated)
      if (filterState.sentFilter === 'only' && !logbook.has(c.uuid)) return false;
      if (filterState.sentFilter === 'hide' && logbook.has(c.uuid)) return false;
      
      const hasRating = logbook.getRating(c.uuid) > 0;
      if (filterState.ratedFilter === 'only' && !hasRating) return false;
      if (filterState.ratedFilter === 'hide' && hasRating) return false;
      
      return true;
    });
  }
  
  // Update subtitle with count
  document.getElementById('rec-subtitle').innerText = `${finalClimbs.length} matches found`;

  let sortedClimbs = [...finalClimbs];

  // Prepend the source climb as the "Anchor" so it's always at the top for comparison
  if (!sortedClimbs.find(c => c.uuid === sourceClimb.uuid)) {
    sourceClimb.isSource = true;
    sortedClimbs.unshift(sourceClimb);
  }

  // Render using handleRoutesUpdate
  handleRoutesUpdate({
    routes: sortedClimbs,
    totalCount: sortedClimbs.length,
    offset: 0
  });
}

function handleRecBack() {
  recommendationStack.pop();
  if (recommendationStack.length === 0) {
    exitRecommendationMode();
  } else {
    renderRecommendationResults();
  }
}

function handleRecHome() {
  recommendationStack = [];
  exitRecommendationMode();
}

function handleRecFilterToggle() {
  ignoreFiltersInRecommendations = !ignoreFiltersInRecommendations;
  renderRecommendationResults();
}

function exitRecommendationMode() {
  document.getElementById('normal-status').classList.remove('hidden');
  document.getElementById('recommendation-status').classList.add('hidden');
  recommendationStack = [];
  triggerSearch(); // Return to original search
}

// Bind recommendation buttons
document.getElementById('rec-home-btn').onclick = handleRecHome;
document.getElementById('rec-back-btn').onclick = handleRecBack;
document.getElementById('rec-filter-btn').onclick = handleRecFilterToggle;

// ----------------------------------------------------
// History & State Preservation Setup
// ----------------------------------------------------
let isHistoryMode = false;

let discoverState = {
  routes: [],
  index: -1,
  offset: 0,
  totalCount: 0,
  recommendationStack: [],
  scrollPos: 0,
  climb: null
};

let historyState = {
  routes: [],
  index: -1,
  offset: 0,
  totalCount: 0,
  recommendationStack: [],
  scrollPos: 0,
  climb: null
};

function saveCurrentViewState() {
  const state = isHistoryMode ? historyState : discoverState;
  state.routes = [...currentRoutes];
  state.index = currentRouteIndex;
  state.offset = currentOffset;
  state.totalCount = totalResultsCount;
  state.recommendationStack = [...recommendationStack];
  state.scrollPos = document.getElementById('route-list').scrollTop;
  state.climb = currentClimb;
}

function switchTab(toHistory) {
  if (isHistoryMode === toHistory) {
    // Allow manual refresh if tapping the History tab while already active
    if (toHistory) triggerHistorySearch();
    return;
  }

  // 1. Save current state
  saveCurrentViewState();

  // 2. Switch mode
  isHistoryMode = toHistory;
  const newState = isHistoryMode ? historyState : discoverState;

  // 3. Update UI Tabs
  document.getElementById('tab-history').classList.toggle('active', isHistoryMode);
  document.getElementById('tab-discover').classList.toggle('active', !isHistoryMode);

  // 4. Restore Variables
  currentRoutes = newState.routes;
  currentRouteIndex = newState.index;
  currentOffset = newState.offset;
  totalResultsCount = newState.totalCount;
  recommendationStack = newState.recommendationStack;
  currentClimb = newState.climb;

  // 5. Re-render UI or Fetch
  if (isHistoryMode) {
    // Always fetch fresh history to avoid stale cache
    triggerHistorySearch();
  } else if (currentRoutes.length > 0) {
    // Restore Discovery list from cache
    
    // Restore the recommendation header if needed
    if (recommendationStack.length > 0) {
      document.getElementById('normal-status').classList.add('hidden');
      document.getElementById('recommendation-status').classList.remove('hidden');
      const stackTop = recommendationStack[recommendationStack.length - 1];
      document.getElementById('rec-title').innerText = `Similar to ${stackTop.sourceClimb.name}`;
      document.getElementById('rec-subtitle').innerText = `${totalResultsCount} matches found`;
    } else {
      document.getElementById('normal-status').classList.remove('hidden');
      document.getElementById('recommendation-status').classList.add('hidden');
    }

    // Re-render list
    handleRoutesUpdate({ 
      routes: currentRoutes, 
      totalCount: totalResultsCount, 
      offset: 0,
      restoreIndex: currentRouteIndex 
    });
    
    // Restore scroll position
    setTimeout(() => {
      document.getElementById('route-list').scrollTop = newState.scrollPos;
    }, 0);
  } else {
    // Empty Discovery state - trigger initial load
    document.getElementById('route-list').innerHTML = '';
    document.getElementById('normal-status').classList.remove('hidden');
    document.getElementById('recommendation-status').classList.add('hidden');
    triggerSearch();
  }
}

document.getElementById('tab-discover').onclick = () => switchTab(false);
document.getElementById('tab-history').onclick = () => switchTab(true);

function triggerHistorySearch() {
  isLoadingRoutes = true;
  document.getElementById('route-list').innerHTML = '<div style="padding: 20px; text-align: center; opacity: 0.5;">Loading History...</div>';
  
  const uuids = logbook.getIlluminated();
  if (uuids.length === 0) {
    document.getElementById('route-list').innerHTML = '<div style="padding: 40px 20px; text-align: center; opacity: 0.5;">No illuminated climbs yet</div>';
    document.getElementById('route-count').innerText = `0 routes found`;
    currentRoutes = [];
    totalResultsCount = 0;
    isLoadingRoutes = false;
    return;
  }
  
  dbClient.getClimbsByUuids(uuids).then(routes => {
    handleRoutesUpdate({ routes, totalCount: routes.length, offset: 0 });
  });
}

init();
