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
    this.cacheMeta = new Map();

    this.stats = {
      totalHits: 0,
      memoryHits: 0,
      diskHits: 0,
      misses: 0,
      processed: 0,
      singleFlightSaved: 0,
      startedAt: Date.now()
    };

    this._indexFile = path.join(config.cache.dir, '_index.json');
    this._dirty = false;
    this._saveTimer = null;

    this._loadIndexFromDisk();
    this._initDiskCacheCleanup();
    this._initIndexAutoSave();
  }

  _initIndexAutoSave() {
    setInterval(() => {
      if (this._dirty) {
        this._saveIndexToDisk();
      }
    }, 30 * 1000);
  }

  _loadIndexFromDisk() {
    try {
      if (!fs.existsSync(this._indexFile)) {
        this._rebuildIndexFromDisk();
        return;
      }

      const raw = fs.readFileSync(this._indexFile, 'utf-8');
      const data = JSON.parse(raw);

      if (data.images && typeof data.images === 'object') {
        for (const [imageId, keys] of Object.entries(data.images)) {
          this.imageCacheIndex.set(imageId, new Set(keys));
        }
      }

      if (data.meta && typeof data.meta === 'object') {
        for (const [key, meta] of Object.entries(data.meta)) {
          this.cacheMeta.set(key, meta);
        }
      }

      console.log(`[Cache] Loaded index: ${this.imageCacheIndex.size} images, ${this.cacheMeta.size} cached items`);
    } catch (e) {
      console.warn('[Cache] Failed to load index, rebuilding from disk...', e.message);
      this._rebuildIndexFromDisk();
    }
  }

  _rebuildIndexFromDisk() {
    try {
      const cacheDir = config.cache.dir;
      if (!fs.existsSync(cacheDir)) return;

      const subDirs = fs.readdirSync(cacheDir);
      let count = 0;

      for (const subDir of subDirs) {
        if (subDir.startsWith('_')) continue;
        const subDirPath = path.join(cacheDir, subDir);
        try {
          const stat = fs.statSync(subDirPath);
          if (!stat.isDirectory()) continue;

          const files = fs.readdirSync(subDirPath);
          for (const file of files) {
            const filePath = path.join(subDirPath, file);
            try {
              const fstat = fs.statSync(filePath);
              const hash = file.replace(/\.[^.]+$/, '');
              const ext = path.extname(file).slice(1);

              if (!this.cacheMeta.has(hash)) {
                this.cacheMeta.set(hash, {
                  format: ext,
                  size: fstat.size,
                  createdAt: fstat.mtimeMs,
                  lastAccess: fstat.atimeMs
                });
              }

              count++;
            } catch (e) {
              // ignore
            }
          }
        } catch (e) {
          // ignore
        }
      }

      this._dirty = true;
      console.log(`[Cache] Rebuilt index from disk: ${count} files, ${this.imageCacheIndex.size} images`);
    } catch (e) {
      console.error('[Cache] Failed to rebuild index:', e.message);
    }
  }

  _saveIndexToDisk() {
    try {
      const data = {
        version: 1,
        savedAt: Date.now(),
        images: {},
        meta: {}
      };

      for (const [imageId, keys] of this.imageCacheIndex.entries()) {
        data.images[imageId] = Array.from(keys);
      }

      for (const [key, meta] of this.cacheMeta.entries()) {
        data.meta[key] = meta;
      }

      const tmpFile = this._indexFile + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(data));
      fs.renameSync(tmpFile, this._indexFile);
      this._dirty = false;
    } catch (e) {
      console.error('[Cache] Failed to save index:', e.message);
    }
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
        if (subDir.startsWith('_')) continue;
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
                const hash = file.replace(/\.[^.]+$/, '');
                this._removeFromImageIndex(hash);
                this.cacheMeta.delete(hash);
                this._dirty = true;
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
    this._dirty = true;
  }

  _removeFromImageIndex(cacheKey) {
    for (const [imageId, keys] of this.imageCacheIndex.entries()) {
      keys.delete(cacheKey);
      if (keys.size === 0) {
        this.imageCacheIndex.delete(imageId);
      }
    }
    this.cacheMeta.delete(cacheKey);
    this._dirty = true;
  }

  _setCacheMeta(cacheKey, format, size) {
    const now = Date.now();
    const existing = this.cacheMeta.get(cacheKey);
    this.cacheMeta.set(cacheKey, {
      format,
      size,
      createdAt: existing ? existing.createdAt : now,
      lastAccess: now
    });
    this._dirty = true;
  }

  get(cacheKeyHash) {
    if (this.memoryCache.has(cacheKeyHash)) {
      return this.memoryCache.get(cacheKeyHash);
    }
    return null;
  }

  getDisk(cacheFilePath, cacheKeyHash) {
    try {
      if (fs.existsSync(cacheFilePath)) {
        const stat = fs.statSync(cacheFilePath);
        const now = Date.now();
        if (now - stat.mtimeMs > config.cache.maxAge) {
          fs.unlinkSync(cacheFilePath);
          this._removeFromImageIndex(cacheKeyHash);
          return null;
        }
        const buffer = fs.readFileSync(cacheFilePath);
        this._setCacheMeta(cacheKeyHash, path.extname(cacheFilePath).slice(1), stat.size);
        return buffer;
      }
    } catch (e) {
      // ignore
    }
    return null;
  }

  getDiskMeta(cacheKeyHash) {
    return this.cacheMeta.get(cacheKeyHash) || null;
  }

  set(cacheKeyHash, data, imageId, cacheFilePath) {
    const format = path.extname(cacheFilePath).slice(1);

    if (cacheFilePath) {
      const dir = path.dirname(cacheFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(cacheFilePath, data);
      this._addToImageIndex(cacheKeyHash, imageId);
      this._setCacheMeta(cacheKeyHash, format, data.length);
    }

    this.memoryCache.set(cacheKeyHash, { buffer: data, timestamp: Date.now() });
  }

  async getOrProcess(cacheKeyHash, imageId, cacheFilePath, processFn) {
    const memCached = this.get(cacheKeyHash);
    if (memCached) {
      this.stats.memoryHits++;
      this.stats.totalHits++;
      return { data: memCached.buffer, fromCache: true, source: 'memory', cacheKey: cacheKeyHash };
    }

    if (this.inFlight.has(cacheKeyHash)) {
      this.stats.singleFlightSaved++;
      this.stats.totalHits++;
      return this.inFlight.get(cacheKeyHash);
    }

    const diskCached = this.getDisk(cacheFilePath, cacheKeyHash);
    if (diskCached) {
      this.memoryCache.set(cacheKeyHash, { buffer: diskCached, timestamp: Date.now() });
      this.stats.diskHits++;
      this.stats.totalHits++;
      return { data: diskCached, fromCache: true, source: 'disk', cacheKey: cacheKeyHash };
    }

    this.stats.misses++;

    const promise = (async () => {
      try {
        const result = await processFn();
        this.set(cacheKeyHash, result, imageId, cacheFilePath);
        this.stats.processed++;
        return { data: result, fromCache: false, source: 'processed', cacheKey: cacheKeyHash };
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

      this.cacheMeta.delete(cacheKeyHash);
    }

    this.imageCacheIndex.delete(imageId);
    this._dirty = true;
    return invalidated;
  }

  invalidateByFormat(format) {
    const targetFormat = format.toLowerCase().replace(/^jpg$/, 'jpeg');
    let invalidated = 0;

    for (const [cacheKeyHash, meta] of this.cacheMeta.entries()) {
      if (meta.format === targetFormat) {
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

        this._removeFromImageIndex(cacheKeyHash);
      }
    }

    this._dirty = true;
    return invalidated;
  }

  invalidateByTimeRange(fromMs, toMs) {
    let invalidated = 0;

    for (const [cacheKeyHash, meta] of this.cacheMeta.entries()) {
      const created = meta.createdAt || 0;
      if (created >= fromMs && created <= toMs) {
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

        this._removeFromImageIndex(cacheKeyHash);
      }
    }

    this._dirty = true;
    return invalidated;
  }

  invalidateByOlderThan(ageMs) {
    const cutoff = Date.now() - ageMs;
    return this.invalidateByTimeRange(0, cutoff);
  }

  getStats() {
    const memoryItemCount = this.memoryCache.size;
    const memorySize = this.memoryCache.calculatedSize;

    let diskTotalSize = 0;
    const formatStats = {};
    const imageRank = [];

    for (const [key, meta] of this.cacheMeta.entries()) {
      diskTotalSize += meta.size || 0;
      const fmt = meta.format || 'unknown';
      formatStats[fmt] = formatStats[fmt] || { count: 0, sizeBytes: 0 };
      formatStats[fmt].count++;
      formatStats[fmt].sizeBytes += meta.size || 0;
    }

    for (const [imageId, keys] of this.imageCacheIndex.entries()) {
      let size = 0;
      for (const key of keys) {
        const meta = this.cacheMeta.get(key);
        if (meta) size += meta.size || 0;
      }
      imageRank.push({ imageId, count: keys.size, sizeBytes: size });
    }

    imageRank.sort((a, b) => b.count - a.count);
    const topImages = imageRank.slice(0, 20);

    const totalRequests = this.stats.totalHits + this.stats.misses;
    const hitRate = totalRequests > 0 ? (this.stats.totalHits / totalRequests * 100).toFixed(2) : '0.00';

    return {
      memory: {
        itemCount: memoryItemCount,
        sizeBytes: memorySize,
        sizeMB: (memorySize / (1024 * 1024)).toFixed(2)
      },
      disk: {
        itemCount: this.cacheMeta.size,
        sizeBytes: diskTotalSize,
        sizeMB: (diskTotalSize / (1024 * 1024)).toFixed(2),
        derivedCount: this.cacheMeta.size,
        imageCount: this.imageCacheIndex.size,
        byFormat: formatStats
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
      ranking: {
        topByCount: topImages.map(img => ({
          ...img,
          sizeMB: (img.sizeBytes / (1024 * 1024)).toFixed(3)
        }))
      },
      uptime: {
        seconds: Math.floor((Date.now() - this.stats.startedAt) / 1000),
        startedAt: new Date(this.stats.startedAt).toISOString()
      },
      inFlight: this.inFlight.size,
      imageIndexSize: this.imageCacheIndex.size
    };
  }

  getImageCacheInfo(imageId) {
    const keys = this.imageCacheIndex.get(imageId);
    if (!keys) {
      return {
        imageId,
        hasCachedVariants: false,
        variantCount: 0,
        totalSizeBytes: 0,
        variants: []
      };
    }

    const variants = [];
    let totalSize = 0;

    for (const key of keys) {
      const meta = this.cacheMeta.get(key);
      if (meta) {
        totalSize += meta.size || 0;
        variants.push({
          key,
          format: meta.format,
          sizeBytes: meta.size,
          sizeKB: ((meta.size || 0) / 1024).toFixed(2),
          createdAt: meta.createdAt ? new Date(meta.createdAt).toISOString() : null,
          lastAccess: meta.lastAccess ? new Date(meta.lastAccess).toISOString() : null
        });
      } else {
        variants.push({
          key,
          format: 'unknown',
          sizeBytes: 0,
          sizeKB: '0.00',
          createdAt: null,
          lastAccess: null
        });
      }
    }

    variants.sort((a, b) => b.sizeBytes - a.sizeBytes);

    return {
      imageId,
      hasCachedVariants: true,
      variantCount: variants.length,
      totalSizeBytes: totalSize,
      totalSizeKB: (totalSize / 1024).toFixed(2),
      totalSizeMB: (totalSize / (1024 * 1024)).toFixed(3),
      variants
    };
  }

  clearAll() {
    this.memoryCache.clear();
    this.inFlight.clear();
    this.imageCacheIndex.clear();
    this.cacheMeta.clear();

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

    this._dirty = true;
    this._saveIndexToDisk();
  }

  _clearDiskCache() {
    try {
      const cacheDir = config.cache.dir;
      if (!fs.existsSync(cacheDir)) return;

      const subDirs = fs.readdirSync(cacheDir);
      for (const subDir of subDirs) {
        if (subDir.startsWith('_')) continue;
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

  forceSaveIndex() {
    this._saveIndexToDisk();
  }
}

module.exports = new ImageCache();
