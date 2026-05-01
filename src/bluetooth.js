export class BluetoothAPI {
  constructor() {
    this.device = null;
    this.server = null;
    this.txCharacteristic = null;
    
    // Standard Nordic UART Service (NUS) UUIDs used by Tension/Kilter
    this.SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
    this.TX_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
    
    this.isConnected = false;

    // Protocol Constants
    this.PACKET_MIDDLE = 81;
    this.PACKET_FIRST = 82;
    this.PACKET_LAST = 83;
    this.PACKET_ONLY = 84;
    this.MAX_MESSAGE_SIZE = 20; // GATT standard MTU chunk
    this.BODY_MAX_LENGTH = 255;
    
    // Diagnostic Mode
    this.debugMode = false; 

    // Stable listener reference
    this._boundDisconnect = this.#handleDisconnect.bind(this);
    this._onDisconnectCallback = null;

    // Write Queue to prevent GATT collisions
    this.writeQueue = [];
    this.isWriting = false;
  }

  /**
   * Nuclear Reset: Clears all internal BLE state.
   * Useful for un-sticking "Dirty" browser objects.
   */
  async reset() {
    if (this.device && this.device.gatt.connected) {
      try {
        this.device.gatt.disconnect();
      } catch (e) { /* ignore */ }
    }
    this.device = null;
    this.server = null;
    this.txCharacteristic = null;
    this.isConnected = false;
    this.clearQueue();
  }

  clearQueue() {
    this.writeQueue = [];
    this.isWriting = false;
  }

  #handleDisconnect() {
    this.isConnected = false;
    this.server = null;
    this.txCharacteristic = null;
    console.log("Bluetooth Disconnected");
    if (this._onDisconnectCallback) this._onDisconnectCallback();
  }

  async connect(onDisconnect, isManual = false) {
    if (!navigator.bluetooth) return false;
    this._onDisconnectCallback = onDisconnect;

    // RULE 1: If manual pairing, always start with a Nuclear Reset
    if (isManual) {
      await this.reset();
    }

    try {
      // 1. Session Persistence Logic
      if (!this.device) {
        // Attempt SEAMLESS RECOVERY via getDevices() if not in manual mode
        if (!isManual && navigator.bluetooth.getDevices) {
          const devices = await navigator.bluetooth.getDevices();
          const rememberedName = localStorage.getItem('lastConnectedBoardName');
          
          if (rememberedName) {
            this.device = devices.find(d => d.name && d.name.startsWith(rememberedName));
          }
          
          if (!this.device) {
            this.device = devices.find(d => 
              d.uuids.includes(this.SERVICE_UUID) || 
              d.name?.startsWith('Tension') || 
              d.name?.startsWith('Aurora')
            );
          }
        }

        // Fallback to PAIRING MENU if still no device
        if (!this.device) {
          if (!isManual && !this.debugMode) throw new Error("DISCOVERY_FAILED");

          const options = this.debugMode 
            ? { acceptAllDevices: true, optionalServices: [this.SERVICE_UUID] }
            : { 
                filters: [
                  { services: [this.SERVICE_UUID] },
                  { namePrefix: 'Tension' },
                  { namePrefix: 'Aurora' }
                ],
                optionalServices: [this.SERVICE_UUID] 
              };

          this.device = await navigator.bluetooth.requestDevice(options);
        }
      }
      
      // 2. Event Listener Management
      this.device.removeEventListener('gattserverdisconnected', this._boundDisconnect);
      this.device.addEventListener('gattserverdisconnected', this._boundDisconnect);

      // 3. Connect GATT
      try {
        this.server = await this.device.gatt.connect();
      } catch (e) {
        this.isConnected = false;
        throw new Error("GATT_CONNECTION_FAILED");
      }
      
      // 4. Discover Services
      let service;
      try {
        service = await this.server.getPrimaryService(this.SERVICE_UUID);
      } catch (e) {
        throw new Error("SERVICE_NOT_FOUND");
      }

      this.txCharacteristic = await service.getCharacteristic(this.TX_UUID);
      
      this.isConnected = true;
      if (this.device.name) {
        localStorage.setItem('lastConnectedBoardName', this.device.name);
      }
      console.log('Bluetooth Connected and Ready!');
      return true;
    } catch (e) {
      if (this.debugMode) console.error("Detailed Connection Error:", e.name, e.message);
      
      let errorMsg = e.message;

      // Map browser-specific errors to our friendly IDs
      if (e.name === 'NotFoundError') {
        if (e.message.toLowerCase().includes('cancel') || e.message.toLowerCase().includes('user')) {
          errorMsg = "USER_CANCELLED";
        } else {
          errorMsg = "DISCOVERY_FAILED";
        }
      } else if (e.name === 'NetworkError' || e.message.toLowerCase().includes('gatt')) {
        errorMsg = "GATT_CONNECTION_FAILED";
      } else if (e.name === 'SecurityError' && e.message.toLowerCase().includes('adapter')) {
        errorMsg = "BLUETOOTH_OFF";
      }

      // RULE 2: If ANY step fails (except user cancel), perform an atomic cleanup
      if (errorMsg !== "USER_CANCELLED" && errorMsg !== "DISCOVERY_FAILED") {
        await this.reset(); // Full teardown
      }
      
      return errorMsg;
    }
  }

  async disconnect() {
    await this.reset();
  }

  // --- Protocol Helpers ---

  checksum(data) {
    let sum = 0;
    for (const val of data) {
      sum = (sum + val) & 255;
    }
    return (~sum) & 255;
  }

  wrapBytes(data) {
    if (data.length > this.BODY_MAX_LENGTH) return [];
    return [0x01, data.length, this.checksum(data), 0x02, ...data, 0x03];
  }

  encodeColor(hex) {
    // 3-3-2 bit RGB encoding
    const r = parseInt(hex.substring(1, 3), 16);
    const g = parseInt(hex.substring(3, 5), 16);
    const b = parseInt(hex.substring(5, 7), 16);

    const r3 = (r / 32) << 5;
    const g3 = (g / 32) << 2;
    const b2 = (b / 64);
    return (r3 | g3 | b2) & 255;
  }

  encodePosition(pos) {
    return [pos & 255, (pos >> 8) & 255];
  }

  async lightRoute(routeFrames, ledMapping) {
    if (!this.isConnected || !this.txCharacteristic || !routeFrames) return;

    // Colors per role for Tension Board 2
    const roleColors = {
      '5': '#00FF00', // Start
      '6': '#0000FF', // Middle
      '7': '#FF0000', // Finish
      '8': '#FF00FF'  // Foot
    };

    const messages = [];
    let currentPayload = [this.PACKET_MIDDLE];

    const placements = routeFrames.split('p').filter(Boolean);
    placements.forEach(p => {
      const [pId, rId] = p.split('r').map(Number);
      const position = ledMapping[pId];
      if (position !== undefined) {
        const colorHex = roleColors[rId] || '#FFFFFF';
        const encodedFrame = [...this.encodePosition(position), this.encodeColor(colorHex)];
        
        if (currentPayload.length + 3 > this.BODY_MAX_LENGTH) {
          messages.push(currentPayload);
          currentPayload = [this.PACKET_MIDDLE];
        }
        currentPayload.push(...encodedFrame);
      }
    });
    messages.push(currentPayload);

    // Update packet type markers (82=First, 83=Last, 84=Only)
    if (messages.length === 1) {
      messages[0][0] = this.PACKET_ONLY;
    } else {
      messages[0][0] = this.PACKET_FIRST;
      messages[messages.length - 1][0] = this.PACKET_LAST;
    }

    // Final framing and transmission
    const fullBuffer = [];
    messages.forEach(msg => {
      fullBuffer.push(...this.wrapBytes(msg));
    });

    const uint8Buffer = Uint8Array.from(fullBuffer);
    
    // Chunk into 20-byte MTU packets and queue for transmission
    for (let i = 0; i < uint8Buffer.length; i += this.MAX_MESSAGE_SIZE) {
      const chunk = uint8Buffer.slice(i, i + this.MAX_MESSAGE_SIZE);
      this.writeQueue.push(chunk);
    }
    
    return this.#processQueue();
  }

  async #processQueue() {
    if (this.isWriting || this.writeQueue.length === 0) return;
    this.isWriting = true;

    try {
      while (this.writeQueue.length > 0) {
        if (!this.isConnected || !this.txCharacteristic) {
          this.clearQueue();
          break;
        }
        const chunk = this.writeQueue.shift();
        await this.txCharacteristic.writeValue(chunk);
      }
      if (this.debugMode) console.log("Broadcasting complete.");
    } catch (e) {
      console.error("GATT Write Failed:", e);
      // On failure, clear queue to prevent stuck state
      this.clearQueue();
    } finally {
      this.isWriting = false;
    }
  }
}
