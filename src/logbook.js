export class Logbook {
  constructor() {
    this.storageKey = 'boardle_logged_climbs';
    this.ratingsKey = 'boardle_climb_ratings';
    this.historyKey = 'boardle_illuminated_history';
    this.loggedUuids = new Set(JSON.parse(localStorage.getItem(this.storageKey) || '[]'));
    this.ratings = JSON.parse(localStorage.getItem(this.ratingsKey) || '{}');
    this.illuminatedHistory = JSON.parse(localStorage.getItem(this.historyKey) || '[]');
  }

  save() {
    localStorage.setItem(this.storageKey, JSON.stringify([...this.loggedUuids]));
    localStorage.setItem(this.ratingsKey, JSON.stringify(this.ratings));
    localStorage.setItem(this.historyKey, JSON.stringify(this.illuminatedHistory));
  }

  toggle(uuid) {
    if (this.loggedUuids.has(uuid)) {
      this.loggedUuids.delete(uuid);
    } else {
      this.loggedUuids.add(uuid);
    }
    this.save();
    return this.loggedUuids.has(uuid);
  }

  has(uuid) {
    return this.loggedUuids.has(uuid);
  }

  setRating(uuid, rating) {
    if (rating === 0) {
      delete this.ratings[uuid];
    } else {
      this.ratings[uuid] = rating;
    }
    this.save();
  }

  getRating(uuid) {
    return this.ratings[uuid] || 0;
  }

  addIlluminated(uuid) {
    if (!uuid) return;
    // Remove existing occurrence to prevent duplicates
    this.illuminatedHistory = this.illuminatedHistory.filter(id => id !== uuid);
    // Add to front
    this.illuminatedHistory.unshift(uuid);
    // Cap at 100
    if (this.illuminatedHistory.length > 100) {
      this.illuminatedHistory = this.illuminatedHistory.slice(0, 100);
    }
    this.save();
  }

  getIlluminated() {
    return this.illuminatedHistory;
  }
}
