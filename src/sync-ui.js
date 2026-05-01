
import { login, sync, downloadAPKDatabase, fetchDatabase } from './aurora-api.js';

export class SyncUI {
  constructor(dbClient) {
    this.dbClient = dbClient;
    this.overlay = null;
    this.init();
  }

  init() {
    // Create the overlay container
    this.overlay = document.createElement('div');
    this.overlay.id = 'sync-overlay';
    this.overlay.className = 'hidden';
    this.overlay.innerHTML = `
      <div class="sync-modal">
        <div class="sync-header">
          <h2>Sync User Data</h2>
          <button id="sync-close">×</button>
        </div>

        <div id="sync-main-content">
          <div class="sync-step">
            <p class="sync-note">Log in to sync unlisted climbs, your logbook, and the latest board updates.</p>
            
            <div id="login-form">
              <div class="input-group">
                <label>Username</label>
                <input type="text" id="sync-username" placeholder="Username" autocomplete="username" />
              </div>
              <div class="input-group">
                <label>Password</label>
                <input type="password" id="sync-password" placeholder="Password" autocomplete="current-password" />
              </div>
              <button id="sync-login-btn">Log In & Sync</button>
            </div>
          </div>

          <div class="sync-divider-container"><div class="sync-divider"></div><span>OR</span><div class="sync-divider"></div></div>

          <div class="sync-step">
            <p class="sync-note">If automatic sync fails, you can manually import a <b>tension.sqlite3</b> file.</p>
            <button id="sync-import-btn" class="secondary-btn">Import Database File</button>
            <input type="file" id="sync-file-input" class="hidden" accept=".sqlite3,.sqlite,.db" />
          </div>

          <div class="sync-step">
            <p class="sync-note">Import board background images (e.g., <b>12x12-tb2-wood.png</b>) to view them offline.</p>
            <button id="sync-images-btn" class="secondary-btn">Import Board Images</button>
            <input type="file" id="sync-images-input" class="hidden" accept="image/*" multiple />
          </div>
        </div>

        <div id="sync-progress" class="hidden">
          <div class="progress-status">
            <span id="sync-status-text">Starting sync...</span>
            <span id="sync-percent">0%</span>
          </div>
          <div class="progress-bar-container">
            <div id="sync-progress-bar"></div>
          </div>
          <div id="sync-log"></div>
        </div>

        <div id="sync-success" class="hidden">
          <div class="success-icon">✓</div>
          <h3>Sync Complete!</h3>
          <p id="success-message">Your database and user data are up to date.</p>
          <button id="sync-finish-btn">Close</button>
        </div>
      </div>
    `;
    document.body.appendChild(this.overlay);

    // Event listeners
    this.overlay.querySelector('#sync-close').onclick = () => this.hide();
    this.overlay.querySelector('#sync-login-btn').onclick = () => this.handleAPISync();
    this.overlay.querySelector('#sync-import-btn').onclick = () => this.overlay.querySelector('#sync-file-input').click();
    this.overlay.querySelector('#sync-file-input').onchange = (e) => this.handleManualImport(e);
    this.overlay.querySelector('#sync-images-btn').onclick = () => this.overlay.querySelector('#sync-images-input').click();
    this.overlay.querySelector('#sync-images-input').onchange = (e) => this.handleImageImport(e);
    this.overlay.querySelector('#sync-finish-btn').onclick = () => this.hide();

    // Inject styles
    this.injectStyles();
  }

  injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      #sync-overlay {
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(15, 23, 42, 0.8);
        backdrop-filter: blur(10px);
        z-index: 5000;
        display: flex;
        justify-content: center;
        align-items: center;
      }
      .sync-modal {
        background: rgba(15, 23, 42, 0.95);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 24px;
        width: 95%;
        max-width: 500px;
        padding: 30px;
        box-shadow: 0 20px 50px rgba(0,0,0,0.5);
        color: white;
        max-height: 90vh;
        overflow-y: auto;
      }
      .sync-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 25px;
      }
      .sync-header h2 { margin: 0; font-size: 1.5rem; }
      #sync-close { background: none; border: none; color: white; font-size: 1.5rem; cursor: pointer; opacity: 0.5; }
      #sync-close:hover { opacity: 1; }
      
      .sync-step-container { display: flex; flex-direction: column; gap: 25px; }
      .sync-step { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.05); border-radius: 16px; padding: 20px; position: relative; }
      .step-badge { position: absolute; top: -10px; left: 20px; background: #3b82f6; color: white; padding: 2px 10px; border-radius: 10px; font-size: 0.7rem; font-weight: 800; text-transform: uppercase; }
      .sync-divider { height: 1px; background: rgba(255,255,255,0.1); margin: 5px 0; display: none; }
      
      .sync-step h3 { margin: 0 0 10px 0; font-size: 1.1rem; }
      .sync-note { font-size: 0.85rem; color: rgba(255,255,255,0.5); margin-bottom: 15px; line-height: 1.4; }
      
      .input-group { margin-bottom: 15px; }
      .input-group label { display: block; font-size: 0.75rem; text-transform: uppercase; margin-bottom: 5px; color: rgba(255,255,255,0.4); font-weight: 600; letter-spacing: 0.5px; }
      .input-group input, .input-group select {
        width: 100%;
        background: rgba(0,0,0,0.2);
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 8px;
        padding: 10px 12px;
        color: white;
        font-family: inherit;
        font-size: 0.95rem;
      }
      
      #sync-apk-btn, #sync-login-btn, .secondary-btn {
        width: 100%;
        padding: 12px;
        font-size: 0.95rem;
        background: #3b82f6;
        border: none;
        color: white;
        border-radius: 8px;
        font-weight: 600;
        cursor: pointer;
        transition: transform 0.2s, background 0.2s;
      }
      .secondary-btn { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); }
      .secondary-btn:hover { background: rgba(255,255,255,0.1); }
      
      .sync-divider-container { display: flex; align-items: center; gap: 15px; margin: 15px 0; color: rgba(255,255,255,0.2); font-size: 0.7rem; font-weight: bold; }
      .sync-divider { flex: 1; height: 1px; background: rgba(255,255,255,0.1); }

      #sync-login-btn:active, .secondary-btn:active { transform: scale(0.98); }
      
      .progress-status { display: flex; justify-content: space-between; margin-bottom: 10px; font-size: 0.9rem; }
      .progress-bar-container {
        width: 100%;
        height: 6px;
        background: rgba(255,255,255,0.1);
        border-radius: 3px;
        overflow: hidden;
        margin-bottom: 20px;
      }
      #sync-progress-bar {
        width: 0%;
        height: 100%;
        background: #3b82f6;
        transition: width 0.3s ease;
      }
      
      #sync-log {
        font-family: 'JetBrains Mono', 'Fira Code', monospace;
        font-size: 0.7rem;
        color: rgba(255,255,255,0.5);
        max-height: 120px;
        overflow-y: auto;
        padding: 10px;
        background: rgba(0,0,0,0.3);
        border-radius: 8px;
        border: 1px solid rgba(255,255,255,0.05);
      }
      
      #sync-success { text-align: center; padding: 20px 0; }
      .success-icon { font-size: 3.5rem; color: #22c55e; margin-bottom: 15px; }
      #sync-finish-btn { width: 100%; margin-top: 20px; background: #22c55e; }


      /* Highlight for unsynced state */
      .needs-sync {
        background: rgba(245, 158, 11, 0.2) !important;
        border: 1px solid rgba(245, 158, 11, 0.5) !important;
        color: #f59e0b !important;
        animation: pulse-orange 2s infinite;
      }
      @keyframes pulse-orange {
        0% { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.4); }
        70% { box-shadow: 0 0 0 10px rgba(245, 158, 11, 0); }
        100% { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0); }
      }
    `;
    document.head.appendChild(style);
  }

  show() {
    this.overlay.classList.remove('hidden');
    this.resetUI();
  }

  async updateButtonStatus() {
    const syncDates = await this.dbClient.getSharedSyncDates();
    const btn = document.getElementById('sync-open-btn');
    if (!btn) return;

    // A sync is required if:
    // 1. It's not a local DB (fresh download from server)
    // 2. OR the sync dates are the default Unix epoch
    const values = Object.values(syncDates);
    const hasDefaultDates = values.length > 0 && values.every(d => d.startsWith('1970'));
    const isSynced = this.isLocal && values.length > 0 && !hasDefaultDates;

    if (!isSynced) {
      btn.classList.add('needs-sync');
      btn.textContent = '⚠ Sync Required';
    } else {
      btn.classList.remove('needs-sync');
      btn.textContent = 'Sync Database';
    }
  }

  hide() {
    this.overlay.classList.add('hidden');
  }

  resetUI() {
    this.overlay.querySelector('#sync-main-content').classList.remove('hidden');
    this.overlay.querySelector('#sync-progress').classList.add('hidden');
    this.overlay.querySelector('#sync-success').classList.add('hidden');
    this.overlay.querySelector('#sync-log').innerHTML = '';
    this.overlay.querySelector('#sync-progress-bar').style.width = '0%';
  }

  log(message) {
    const logEl = this.overlay.querySelector('#sync-log');
    const div = document.createElement('div');
    div.textContent = `> ${message}`;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
  }

  async handleAPKDownload(options = {}) {
    const { isInitialSetup = false } = options;
    const board = 'tension';
    
    // UI elements
    const statusText = isInitialSetup ? document.getElementById('setup-status') : this.overlay.querySelector('#sync-status-text');
    const progressBar = isInitialSetup ? document.getElementById('setup-progress-fill') : this.overlay.querySelector('#sync-progress-bar');
    
    try {
      if (!isInitialSetup) {
        this.overlay.querySelector('#sync-main-content').classList.add('hidden');
        this.overlay.querySelector('#sync-progress').classList.remove('hidden');
      }

      if (statusText) statusText.textContent = 'Fetching database...';
      this.log('Connecting to official sources...');
      
      let buffer;
      try {
        this.log('Checking for optimized cloud version...');
        buffer = await fetchDatabase(board);
        this.log('Cloud version found! Installing...');
      } catch (e) {
        this.log('Cloud version not found. Falling back to APK extract...');
        buffer = await downloadAPKDatabase(board);
      }

      this.log(`Download complete! Processing data...`);
      
      if (progressBar) progressBar.style.width = '50%';
      if (statusText) statusText.textContent = 'Installing database...';

      // Install base DB
      await this.dbClient.replaceDatabase(buffer);
      this.log('Installation complete.');

      if (progressBar) progressBar.style.width = '100%';
      
      if (!isInitialSetup) {
        this.overlay.querySelector('#success-message').textContent = 'Database refreshed! You can now sync your user data if needed.';
        this.overlay.querySelector('#sync-progress').classList.add('hidden');
        this.overlay.querySelector('#sync-success').classList.remove('hidden');
      }
      
      // Update UI button status
      this.isLocal = true;
      this.updateButtonStatus();

      // Seamless reload
      if (window.reinitApp) {
        await window.reinitApp();
      }
      
      if (isInitialSetup && typeof options.onComplete === 'function') {
        options.onComplete();
      }
    } catch (err) {
      this.log(`ERROR: ${err.message}`);
      alert(`Initialization Failed: ${err.message}`);
      if (!isInitialSetup) this.resetUI();
    }
  }

  async handleImageImport(event) {
    const files = Array.from(event.target.files);
    if (files.length === 0) return;

    try {
      this.overlay.querySelector('#sync-main-content').classList.add('hidden');
      this.overlay.querySelector('#sync-progress').classList.remove('hidden');
      
      let count = 0;
      for (const file of files) {
        this.log(`Importing ${file.name} (${count + 1}/${files.length})...`);
        const buffer = await file.arrayBuffer();
        
        // Save to worker
        const requestId = `save_img_${Date.now()}_${count}`;
        await new Promise((resolve) => {
          const handler = (e) => {
            if (e.data.type === requestId) {
              this.dbClient.worker.removeEventListener('message', handler);
              resolve();
            }
          };
          this.dbClient.worker.addEventListener('message', handler);
          this.dbClient.worker.postMessage({ 
            type: 'SAVE_IMAGE', 
            payload: { filename: file.name, buffer, requestId } 
          });
        });
        
        count++;
        const progress = Math.round((count / files.length) * 100);
        this.overlay.querySelector('#sync-progress-bar').style.width = `${progress}%`;
      }

      this.log(`Successfully imported ${count} images!`);
      this.overlay.querySelector('#sync-success').classList.remove('hidden');
      this.overlay.querySelector('#sync-progress').classList.add('hidden');
      this.overlay.querySelector('#success-message').textContent = `Imported ${count} images into local storage.`;

      if (window.reinitApp) {
        await window.reinitApp();
      }
    } catch (err) {
      this.log(`ERROR: ${err.message}`);
      alert(`Image Import Failed: ${err.message}`);
      this.resetUI();
    }
  }

  async handleManualImport(event) {
    const file = event.target.files[0];
    if (!file) return;

    try {
      this.overlay.querySelector('#sync-main-content').classList.add('hidden');
      this.overlay.querySelector('#sync-progress').classList.remove('hidden');
      this.log(`Reading file: ${file.name}...`);
      
      const buffer = await file.arrayBuffer();
      this.log('File loaded. Installing into browser storage...');

      await this.dbClient.replaceDatabase(buffer);
      this.log('Installation successful!');

      this.overlay.querySelector('#sync-progress-bar').style.width = '100%';
      this.overlay.querySelector('#sync-success').classList.remove('hidden');
      this.overlay.querySelector('#sync-progress').classList.add('hidden');
      this.overlay.querySelector('#success-message').textContent = 'Database imported successfully from local file.';

      this.isLocal = true;
      this.updateButtonStatus();

      if (window.reinitApp) {
        await window.reinitApp();
      }
    } catch (err) {
      this.log(`ERROR: ${err.message}`);
      alert(`Import Failed: ${err.message}`);
      this.resetUI();
    }
  }

  async handleAPISync() {
    const board = 'tension';
    const username = this.overlay.querySelector('#sync-username').value;
    const password = this.overlay.querySelector('#sync-password').value;

    if (!username || !password) {
      alert('Please enter both username and password');
      return;
    }

    try {
      this.overlay.querySelector('#sync-main-content').classList.add('hidden');
      this.overlay.querySelector('#sync-progress').classList.remove('hidden');
      this.log('Authenticating...');

      const token = await login(board, username, password);
      this.log('Login successful!');

      // Get existing sync dates
      this.log('Checking existing sync status...');
      const existingSyncDates = await this.dbClient.getSharedSyncDates();
      
      const tablesToSync = {
        climbs: existingSyncDates.climbs || '1970-01-01 00:00:00',
        climb_stats: existingSyncDates.climb_stats || '1970-01-01 00:00:00'
      };
      
      this.log(`Syncing from latest available update...`);
      this.overlay.querySelector('#sync-status-text').textContent = 'Syncing user data...';
      
      let page = 1;
      for await (const syncData of sync(board, tablesToSync, token)) {
        this.log(`Syncing API page ${page}...`);
        await this.dbClient.applySync(syncData);
        
        page++;
        const progress = Math.min(90, (page * 5));
        this.overlay.querySelector('#sync-progress-bar').style.width = `${progress}%`;
        this.overlay.querySelector('#sync-percent').textContent = `${progress}%`;
      }

      this.log('API Sync Complete! Finalizing...');
      this.overlay.querySelector('#sync-progress-bar').style.width = '95%';
      this.overlay.querySelector('#sync-percent').textContent = '95%';
      
      // Save the final merged DB
      const saveReqId = `save_${Date.now()}`;
      await new Promise((resolve) => {
        const handler = (e) => {
          if (e.data.type === saveReqId) {
            this.dbClient.worker.removeEventListener('message', handler);
            resolve();
          }
        };
        this.dbClient.worker.addEventListener('message', handler);
        this.dbClient.worker.postMessage({ type: 'SAVE_DB', payload: { requestId: saveReqId } });
      });

      // Seamless reload
      if (window.reinitApp) {
        await window.reinitApp();
      }

      this.overlay.querySelector('#sync-progress-bar').style.width = '100%';
      this.overlay.querySelector('#sync-percent').textContent = '100%';
      this.log('Syncing complete!');
      
      this.overlay.querySelector('#success-message').textContent = 'User data and climbs synchronized successfully.';
      this.overlay.querySelector('#sync-progress').classList.add('hidden');
      this.overlay.querySelector('#sync-success').classList.remove('hidden');
      
      this.isLocal = true;
      this.updateButtonStatus();

    } catch (err) {
      this.log(`ERROR: ${err.message}`);
      alert(`Sync Failed: ${err.message}`);
      this.resetUI();
    }
  }
}
