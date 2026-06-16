const { LRUCache } = require('lru-cache');

const MAX_LOGS = 500;

class AccessAudit {
  constructor() {
    this.logs = [];
    this.stats = {
      totalRequests: 0,
      totalHits: 0,
      totalMisses: 0,
      totalErrors: 0,
      totalBlocked: 0,
      byImage: new Map(),
      byFormat: new Map()
    };
  }

  record(entry) {
    const logEntry = {
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      timestamp: Date.now(),
      ...entry
    };

    this.logs.unshift(logEntry);
    if (this.logs.length > MAX_LOGS) {
      this.logs.pop();
    }

    this.stats.totalRequests++;
    if (entry.statusCode >= 200 && entry.statusCode < 400) {
      if (entry.cacheSource === 'memory' || entry.cacheSource === 'disk') {
        this.stats.totalHits++;
      } else if (entry.cacheSource === 'processed') {
        this.stats.totalMisses++;
      }
    } else if (entry.statusCode >= 400) {
      this.stats.totalErrors++;
    }

    if (entry.statusCode === 429) {
      this.stats.totalBlocked++;
    }

    if (entry.imageId) {
      if (!this.stats.byImage.has(entry.imageId)) {
        this.stats.byImage.set(entry.imageId, { count: 0, hits: 0, misses: 0 });
      }
      const imgStat = this.stats.byImage.get(entry.imageId);
      imgStat.count++;
      if (entry.cacheSource === 'memory' || entry.cacheSource === 'disk') {
        imgStat.hits++;
      } else if (entry.cacheSource === 'processed') {
        imgStat.misses++;
      }
    }

    if (entry.format) {
      if (!this.stats.byFormat.has(entry.format)) {
        this.stats.byFormat.set(entry.format, { count: 0 });
      }
      this.stats.byFormat.get(entry.format).count++;
    }
  }

  getLogs(limit = 100, options = {}) {
    let result = this.logs;

    if (options.imageId) {
      result = result.filter(l => l.imageId === options.imageId);
    }
    if (options.statusCode) {
      result = result.filter(l => l.statusCode === options.statusCode);
    }
    if (options.cacheSource) {
      result = result.filter(l => l.cacheSource === options.cacheSource);
    }
    if (options.path) {
      result = result.filter(l => l.path && l.path.includes(options.path));
    }

    return {
      total: result.length,
      limit,
      logs: result.slice(0, limit).map(l => ({
        ...l,
        time: new Date(l.timestamp).toISOString()
      }))
    };
  }

  getStats() {
    const topImages = Array.from(this.stats.byImage.entries())
      .map(([imageId, s]) => ({ imageId, ...s }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    const byFormatArr = Array.from(this.stats.byFormat.entries())
      .map(([format, s]) => ({ format, ...s }))
      .sort((a, b) => b.count - a.count);

    return {
      totalRequests: this.stats.totalRequests,
      totalHits: this.stats.totalHits,
      totalMisses: this.stats.totalMisses,
      totalErrors: this.stats.totalErrors,
      totalBlocked: this.stats.totalBlocked,
      hitRate: this.stats.totalRequests > 0
        ? (this.stats.totalHits / this.stats.totalRequests * 100).toFixed(2) + '%'
        : '0.00%',
      topImages,
      byFormat: byFormatArr,
      recentLogs: this.logs.length
    };
  }

  createMiddleware() {
    return (req, res, next) => {
      const startTime = Date.now();
      req._auditStartTime = startTime;

      const originalEnd = res.end;
      res.end = (...args) => {
        res.end = originalEnd;

        const durationMs = Date.now() - startTime;
        const cacheSource = res.getHeader
          ? (res.getHeader('X-Cache-Source') || '')
          : '';
        const preset = res.getHeader ? (res.getHeader('X-Preset') || '') : '';

        const entry = {
          ip: req.ip || req.connection.remoteAddress,
          method: req.method,
          path: req.path,
          imageId: req.params && req.params.id ? req.params.id : null,
          statusCode: res.statusCode,
          durationMs,
          cacheSource: cacheSource || null,
          preset: preset || null,
          userAgent: req.headers['user-agent'] || null,
          referer: req.headers['referer'] || null
        };

        this.record(entry);

        return originalEnd.apply(res, args);
      };

      next();
    };
  }
}

module.exports = new AccessAudit();
