export class DatabaseClient {
  constructor() {
    this.worker = new Worker(new URL('./database.worker.js', import.meta.url));
    this.resolvers = {};
    this.worker.onmessage = this.handleMessage.bind(this);
  }

  handleMessage(e) {
    const { type, payload, requestId } = e.data;
    if (type === 'ERROR') {
      console.error('Database Error:', payload);
      const rid = requestId || 'READY';
      if (this.resolvers[rid]) {
        if (rid.includes('READY')) {
          this.resolvers[rid]({ placements: [], ledMapping: {}, angles: [], grades: [], boardImages: [] });
        } else {
          this.resolvers[rid](null);
        }
        delete this.resolvers[rid];
      }
    } else if (this.resolvers[type]) {
      this.resolvers[type](payload);
      delete this.resolvers[type];
    } else if (type === 'RESULTS' && this.onResults) {
      this.onResults(payload);
    }
  }

  init() {
    return new Promise((resolve) => {
      const requestId = 'READY_' + Date.now();
      this.resolvers[requestId] = resolve;
      this.worker.postMessage({ type: 'INIT', payload: { requestId } });
    });
  }

  refreshBoardState() {
    return new Promise((resolve) => {
      const requestId = 'READY_' + Date.now();
      this.resolvers[requestId] = resolve;
      this.worker.postMessage({ type: 'READY', payload: { requestId } });
    });
  }

  search(selectedHolds, offset = 0, limit = 50, filters = {}, context = {}) {
    this.worker.postMessage({ 
      type: 'SEARCH', 
      payload: { 
        selectedHolds, 
        offset, 
        limit, 
        filters,
        sentUuids: context.sentUuids || [],
        ratedUuids: context.ratedUuids || []
      } 
    });
  }

  setOnResults(callback) {
    this.onResults = callback;
  }

  getSimilarClimbs(uuid) {
    return new Promise((resolve) => {
      const requestId = `similar_${Date.now()}_${Math.random()}`;
      this.resolvers[requestId] = resolve;
      this.worker.postMessage({ type: 'GET_SIMILAR_CLIMBS', payload: { uuid, requestId } });
    });
  }

  getClimbsByUuids(uuids) {
    return new Promise((resolve) => {
      const requestId = 'GET_BY_UUIDS_' + Date.now() + '_' + Math.random();
      this.resolvers[requestId] = resolve;
      this.worker.postMessage({ type: 'GET_BY_UUIDS', payload: { uuids, requestId } });
    });
  }

  getSharedSyncDates() {
    return new Promise((resolve) => {
      const requestId = 'GET_SHARED_SYNC_DATES_' + Date.now();
      this.resolvers[requestId] = resolve;
      this.worker.postMessage({ type: 'GET_SHARED_SYNC_DATES', payload: { requestId } });
    });
  }

  processSyncChunk(chunk) {
    return new Promise((resolve) => {
      const requestId = 'PROCESS_SYNC_CHUNK_' + Date.now();
      this.resolvers[requestId] = resolve;
      this.worker.postMessage({ type: 'PROCESS_SYNC_CHUNK', payload: { chunk, requestId } });
    });
  }

  replaceDatabase(buffer) {
    return new Promise((resolve, reject) => {
      const requestId = 'REPLACE_DB_' + Date.now();
      this.resolvers[requestId] = resolve;
      this.worker.postMessage({ type: 'REPLACE_DB', payload: { buffer, requestId } });
    });
  }

  applySync(tables) {
    return new Promise((resolve, reject) => {
      const requestId = 'APPLY_SYNC_' + Date.now();
      this.resolvers[requestId] = resolve;
      this.worker.postMessage({ type: 'APPLY_SYNC', payload: { tables, requestId } });
    });
  }

  saveImage(filename, buffer) {
    return new Promise((resolve) => {
      const requestId = 'SAVE_IMG_' + Date.now() + '_' + Math.random();
      this.resolvers[requestId] = resolve;
      this.worker.postMessage({ type: 'SAVE_IMAGE', payload: { filename, buffer, requestId } });
    });
  }

  getImage(filename) {
    return new Promise((resolve) => {
      const requestId = 'GET_IMG_' + Date.now() + '_' + Math.random();
      this.resolvers[requestId] = resolve;
      this.worker.postMessage({ type: 'GET_IMAGE', payload: { filename, requestId } });
    });
  }
}
