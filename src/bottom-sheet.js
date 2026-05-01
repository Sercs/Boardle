export class BottomSheet {
  constructor(element) {
    this.element = element;
    this.handle = element.querySelector('#bottom-sheet-handle');
    
    this.startY = 0;
    this.currentY = 0;
    this.lastTime = 0;
    this.lastY = 0;
    this.velocity = 0;
    
    this.isDragging = false;
    
    this.minY = window.innerHeight * 0.05; // 95% height max
    this.maxY = window.innerHeight * 0.95; // 5% height min
    
    this.translateY = window.innerHeight * 0.8; // Default

    this.bindEvents();
    this.updatePosition();
  }

  bindEvents() {
    this.element.addEventListener('touchstart', (e) => {
      this.isTouch = true;
      this.onDragStart(e);
    }, { passive: false });
    
    window.addEventListener('touchmove', (e) => {
      if (this.isDragging) this.onDragMove(e);
    }, { passive: false });
    
    window.addEventListener('touchend', this.onDragEnd.bind(this));
    
    this.element.addEventListener('mousedown', (e) => {
      if (this.isTouch) return; // Ignore ghost clicks
      this.onDragStart(e);
    });
    
    window.addEventListener('mousemove', (e) => {
       if (!this.isTouch && this.isDragging) this.onDragMove(e);
    });
    
    window.addEventListener('mouseup', (e) => {
      if (this.isTouch) {
        // Reset touch flag after a delay to allow ghost events to pass
        setTimeout(() => { this.isTouch = false; }, 500);
        return;
      }
      this.onDragEnd(e);
    });
  }

  onDragStart(e) {
    // Ignore dragging if starting on the scrollable list or its children
    if (e.target.closest('#route-list')) return;
    
    this.isDragging = true;
    this.element.classList.add('dragging');
    this.startY = e.type === 'touchstart' ? e.touches[0].clientY : e.clientY;
    this.startX = e.type === 'touchstart' ? e.touches[0].clientX : e.clientX;
    this.dragStartTime = performance.now();
    this.dragStartDist = 0;
    this.lastStartEvent = e; // Store to pass to tap callback
    
    this.lastY = this.translateY;
    this.lastTime = performance.now();
    this.velocity = 0;
  }

  onDragMove(e) {
    if (!this.isDragging) return;
    
    // Prevent default scroll
    if (e.type === 'touchmove') e.preventDefault();
    
    const clientY = e.type === 'touchmove' ? e.touches[0].clientY : e.clientY;
    const clientX = e.type === 'touchmove' ? e.touches[0].clientX : e.clientX;
    const deltaY = clientY - this.startY;
    const deltaX = clientX - this.startX;
    
    this.dragStartDist = Math.hypot(deltaX, deltaY);

    let newY = this.lastY + deltaY;
    
    // Free adjust: strictly clamp values without rubber banding
    if (newY < this.minY) newY = this.minY;
    if (newY > this.maxY) newY = this.maxY;
    
    this.translateY = newY;
    this.updatePosition();
    
    const now = performance.now();
    const dt = now - this.lastTime;
    if (dt > 0) {
      this.velocity = (deltaY) / dt; 
      this.lastTime = now;
    }
  }

  onDragEnd() {
    if (!this.isDragging) return;
    
    const duration = performance.now() - this.dragStartTime;
    if (duration < 200 && this.dragStartDist < 10) {
      if (this.onTapCallback) this.onTapCallback(this.lastStartEvent);
    }

    this.isDragging = false;
    this.element.classList.remove('dragging');
  }

  setOnTap(callback) {
    this.onTapCallback = callback;
  }

  updatePosition() {
    this.element.style.transform = `translateY(${this.translateY}px)`;
    
    // Dynamically pad the internal scroll view by precisely the amount 
    // of pixels physically pushed below the device bezel!
    const routeList = document.getElementById('route-list');
    if (routeList) {
      // 1:1 compensation for off-screen distance + safety buffer for mobile bezel
      const safetyBuffer = 120;
      routeList.style.paddingBottom = `${this.translateY + safetyBuffer}px`;
    }
  }
  
  collapseDown() {
    // Utility to quickly hide the menu if they tap a route
    // Only collapses if it's currently blocking more than half the board
    if (this.translateY < window.innerHeight * 0.7) {
      this.translateY = window.innerHeight * 0.7; // Push it down enough to see the board
      this.updatePosition();
    }
  }
}
