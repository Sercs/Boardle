export class RadialMenu {
  constructor(element, onSelect) {
    this.element = element;
    this.onSelect = onSelect;
    this.sectors = Array.from(this.element.querySelectorAll('.sector'));
    this.activeSector = null;
    this.origin = null;
    this.threshold = 40; // px for deadpoint (shrunk with menu)
    this.activeHoldId = null;

    // Prevent default touch actions while menu is open
    this.element.addEventListener('touchmove', e => e.preventDefault(), { passive: false });
  }

  show(x, y, holdId) {
    this.activeHoldId = holdId;
    this.origin = { x, y };
    this.element.style.left = `${x}px`;
    this.element.style.top = `${y}px`;
    this.element.classList.remove('hidden');
    // small reflow
    void this.element.offsetWidth;
    this.element.classList.add('visible');
    
    this.clearSectors();
  }

  hide() {
    this.element.classList.remove('visible');
    setTimeout(() => {
      this.element.classList.add('hidden');
      this.origin = null;
      this.activeHoldId = null;
      this.clearSectors();
    }, 200); // match CSS transition
  }

  clearSectors() {
    this.sectors.forEach(s => s.classList.remove('active'));
    this.activeSector = null;
  }

  updateTrack(x, y) {
    if (!this.origin) return;
    
    let dx = x - this.origin.x;
    let dy = y - this.origin.y;
    let dist = Math.sqrt(dx*dx + dy*dy);

    this.clearSectors();

    if (dist > this.threshold) {
      // Angle mapped to diamond quadrants
      // East: -PI/4 to PI/4
      // South: PI/4 to 3PI/4
      // West: 3PI/4 to PI OR -PI to -3PI/4
      // North: -3PI/4 to -PI/4
      let angle = Math.atan2(dy, dx);
      let targetRole = null;
      
      if (angle >= -Math.PI/4 && angle < Math.PI/4) {
        targetRole = 'middle'; // East -> Middle
      } else if (angle >= Math.PI/4 && angle < 3*Math.PI/4) {
        targetRole = 'start'; // South -> Start
      } else if (angle >= 3*Math.PI/4 || angle < -3*Math.PI/4) {
        targetRole = 'foot'; // West -> Foot
      } else if (angle >= -3*Math.PI/4 && angle < -Math.PI/4) {
        targetRole = 'finish'; // North -> Finish
      }
      
      if (targetRole) {
        const sector = this.sectors.find(s => s.dataset.role === targetRole);
        if (sector) {
          sector.classList.add('active');
          this.activeSector = targetRole;
        }
      }
    }
  }

  finishTrack() {
    if (this.origin) {
      // Only trigger selection if a sector was actually chosen
      if (this.activeSector) {
        this.onSelect(this.activeHoldId, this.activeSector);
      }
      this.hide();
    }
  }
}
