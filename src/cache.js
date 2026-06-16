const fs = require('fs');
const path = require('path');
const { LRUCache } = require('lru-cache');
const config = require('./config');
const cacheKeyUtil = require('./cacheKey');

class ImageCache {
  constructor() {
    this.memoryCache = new LRUCache({
      max: config.cache.memoryMaxItems,
      maxSize: Math.floor(config.cache.maxSize / 2),
      ttl: config.cache.maxAge,
      updateAgeOnGet: true,
      sizeCalculation: (value) => {
        if (value && value.buffer) {
          return value.buffer.length;
        }
        return 1024;
      }
    });

    this.inFlight = new Map();
    this.imageCacheIndex = new Map();

    this.stats = {
      totalHits: 0,
      memoryHits: 0,
      diskHits: 0,
      misses: 0,
      processed: 0,
      singleFlightSaved: 0,
      startedAt: Date.now()
    };

    this._initDiskCacheCleanup();
  }

  _initDiskCacheCleanup() {
    setInterval(() => {
      this._cleanupExpiredDiskCache();
    }, 60 * 60 * 1000);
  }

  _cleanupExpiredDiskCache() {
    try {
      const now = Date.now();
      const cacheDir = config.cache.dir;

      if (!fs.existsSync(cacheDir)) return;

      const subDirs = fs.readdirSync(cacheDir);
      for (const subDir of subDirs) {
        const subDirPath = path.join(cacheDir, subDir);
        try {
          const stat = fs.statSync(subDirPath);
          if (!stat.isDirectory()) continue;

          const files = fs.readdirSync(subDirPath);
          for (const file of files) {
            const filePath = path.join(subDirPath, file);
            try {
              const fstat = fs.statSync(filePath);
              if (now - fstat.mtimeMs > config.cache.maxAge) {
                fs.unlinkSync(filePath);
                this._removeFromImageIndex(file.replace(/\.[^.]+$/, ''));
              }
            } catch (e) {
              // ignore
            }
          }
        } catch (e) {
          // ignore
        }
      }
    } catch (e) {
      // ignore
    }
  }

  _addToImageIndex(cacheKey, imageId) {
    if (!this.imageCacheIndex.has(imageId)) {
      this.imageCacheIndex.set(imageId, new Set());
    }
    this.imageCacheIndex.get(imageId).add(cacheKey);
  }

  _removeFromImageIndex(cacheKey) {
    for (const [imageId, keys] of this.imageCacheIndex.entries()) {
      keys.delete(cacheKey);
      if (keys.size === 0) {
        this.imageCacheIndex.delete(imageId);
      }
    }
  }

  get(cacheKeyHash) {
    if (this.memoryCache.has(cacheKeyHash)) {
      return this.memoryCache.get(cacheKeyHash);
    }
    return null;
  }

  getDisk(cacheFilePath) {
    try {
      if (fs.existsSync(cacheFilePath)) {
        const stat = fs.statSync(cacheFilePath);
        const now = Date.now();
        if (now - stat.mtimeMs > config.cache.maxAge) {
          fs.unlinkSync(cacheFilePath);
          return null;
        }
        return fs.readFileSync(cacheFilePath);
      }
    } catch (e) {
      // ignore
    }
    return null;
  }

  set(cacheKeyHash, data, imageId, cacheFilePath) {
    if (cacheFilePath) {
      const dir = path.dirname(cacheFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(cacheFilePath, data);
      this._addToImageIndex(cacheKeyHash, imageId);
    }

    this.memoryCache.set(cacheKeyHash, { buffer: data, timestamp: Date.now() });
  }

  async getOrProcess(cacheKeyHash, imageId, cacheFilePath, processFn) {
    const memCached = this.get(cacheKeyHash);
    if (memCached) {
      this.stats.memoryHits++;
      this.stats.totalHits++;
      return { data: memCached.buffer, fromCache: true, source: 'memory' };
    }

    if (this.inFlight.has(cacheKeyHash)) {
      this.stats.singleFlightSaved++;
      this.stats.totalHits++;
      return this.inFlight.get(cacheKeyHash);
    }

    const diskCached = this.getDisk(cacheFilePath);
    if (diskCached) {
      this.memoryCache.set(cacheKeyHash, { buffer: diskCached, timestamp: Date.now() });
      this.stats.diskHits++;
      this.stats.totalHits++;
      return { data: diskCached, fromCache: true, source: 'disk' };
    }

    this.stats.misses++;

    const promise = (async () => {
      try {
        const result = await processFn();
        this.set(cacheKeyHash, result, imageId, cacheFilePath);
        this.stats.processed++;
        return { data: result, fromCache: false, source: 'processed' };
      } finally {
        this.inFlight.delete(cacheKeyHash);
      }
    })();

    this.inFlight.set(cacheKeyHash, promise);
    return promise;
  }

  invalidateByImageId(imageId) {
    const cacheKeys = this.imageCacheIndex.get(imageId);
    if (!cacheKeys) return 0;

    let invalidated = 0;
    for (const cacheKeyHash of cacheKeys) {
      this.memoryCache.delete(cacheKeyHash);

      const subDir = cacheKeyHash.substring(0, 2);
      const possibleDir = path.join(config.cache.dir, subDir);
      try {
        if (fs.existsSync(possibleDir)) {
          const files = fs.readdirSync(possibleDir);
          for (const file of files) {
            if (file.startsWith(cacheKeyHash)) {
              try {
                fs.unlinkSync(path.join(possibleDir, file));
                invalidated++;
              } catch (e) {
                // ignore
              }
            }
          }
        }
      } catch (e) {
        // ignore
      }
    }

    this.imageCacheIndex.delete(imageId);
    return invalidated;
  }

  getStats() {
    const memoryItemCount = this.memoryCache.size;
    const memorySize = this.memoryCache.calculatedSize;
    const derivedImageCount = this._countDiskCacheFiles();

    const totalRequests = this.stats.totalHits + this.stats.misses;
    const hitRate = totalRequests > 0 ? (this.stats.totalHits / totalRequests * 100).toFixed(2) : '0.00';

    return {
      memory: {
        itemCount: memoryItemCount,
        sizeBytes: memorySize,
        sizeMB: (memorySize / (1024 * 1024)).toFixed(2)
      },
      disk: {
        derivedCount: derivedImageCount
      },
      stats: {
        totalHits: this.stats.totalHits,
        memoryHits: this.stats.memoryHits,
        diskHits: this.stats.diskHits,
        misses: this.stats.misses,
        processed: this.stats.processed,
        singleFlightSaved: this.stats.singleFlightSaved,
        hitRate: `${hitRate}%`
      },
      uptime: {
        seconds: Math.floor((Date.now() - this.stats.startedAt) / 1000),
        startedAt: new Date(this.stats.startedAt).toISOString()
      },
      inFlight: this.inFlight.size,
      imageIndexSize: this.imageCacheIndex.size
    };
  }

  _countDiskCacheFiles() {
    try {
      const cacheDir = config.cache.dir;
      if (!fs.existsSync(cacheDir)) return 0;

      let count = 0;
      const subDirs = fs.readdirSync(cacheDir);
      for (const subDir of subDirs) {
        const subDirPath = path.join(cacheDir, subDir);
        try {
          const stat = fs.statSync(subDirPath);
          if (stat.isDirectory()) {
            const files = fs.readdirSync(subDirPath);
            count += files.length;
          }
        } catch (e) {
          // ignore
        }
      }
      return count;
    } catch (e) {
      return 0;
    }
  }

  clearAll() {
    this.memoryCache.clear();
    this.inFlight.clear();
    this.imageCacheIndex.clear();

    this._clearDiskCache();

    this.stats = {
      totalHits: 0,
      memoryHits: 0,
      diskHits: 0,
      misses: 0,
      processed: 0,
      singleFlightSaved: 0,
      startedAt: Date.now()
    };
  }

  _clearDiskCache() {
    try {
      const cacheDir = config.cache.dir;
      if (!fs.existsSync(cacheDir)) return;

      const subDirs = fs.readdirSync(cacheDir);
      for (const subDir of subDirs) {
        const subDirPath = path.join(cacheDir, subDir);
        try {
          const stat = fs.statSync(subDirPath);
          if (stat.isDirectory()) {
            const files = fs.readdirSync(subDirPath);
            for (const file of files) {
              try {
                fs.unlinkSync(path.join(subDirPath, file));
              } catch (e) {
                // ignore
              }
            }
            try {
              fs.rmdirSync(subDirPath);
            } catch (e) {
              // ignore
            }
          }
        } catch (e) {
          // ignore
        }
      }
    } catch (e) {
      // ignore
    }
  }
}

module.exports = new ImageCache();
