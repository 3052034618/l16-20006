const { LRUCache } = require('lru-cache');
const config = require('./config');

const DEFAULT_WINDOW_MS = 60 * 1000;
const DEFAULT_MAX_PER_WINDOW = 30;
const MAX_CLIENTS = 1000;

class RateLimiter {
  constructor() {
    this.clients = new LRUCache({
      max: MAX_CLIENTS,
      ttl: DEFAULT_WINDOW_MS * 2
    });

    this.windowMs = config.rateLimit && config.rateLimit.windowMs
      ? config.rateLimit.windowMs
      : DEFAULT_WINDOW_MS;
    this.maxPerWindow = config.rateLimit && config.rateLimit.maxPerWindow
      ? config.rateLimit.maxPerWindow
      : DEFAULT_MAX_PER_WINDOW;
  }

  _getClientKey(req) {
    if (req.query && req.query.sign) {
      return `sign:${req.query.sign.slice(0, 16)}`;
    }
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    return `ip:${ip}`;
  }

  check(req) {
    const key = this._getClientKey(req);
    const now = Date.now();

    let timestamps = this.clients.get(key);
    if (!timestamps) {
      timestamps = [];
    }

    const windowStart = now - this.windowMs;
    timestamps = timestamps.filter(t => t > windowStart);

    if (timestamps.length >= this.maxPerWindow) {
      this.clients.set(key, timestamps);
      return {
        allowed: false,
        remaining: 0,
        resetAt: timestamps[0] + this.windowMs,
        limit: this.maxPerWindow
      };
    }

    timestamps.push(now);
    this.clients.set(key, timestamps);

    return {
      allowed: true,
      remaining: this.maxPerWindow - timestamps.length,
      resetAt: now + this.windowMs,
      limit: this.maxPerWindow
    };
  }

  middleware(checkOnRequest = false) {
    return (req, res, next) => {
      if (!checkOnRequest) {
        return next();
      }

      const result = this.check(req);
      if (!result.allowed) {
        res.setHeader('X-RateLimit-Limit', result.limit);
        res.setHeader('X-RateLimit-Remaining', 0);
        res.setHeader('X-RateLimit-Reset', Math.ceil(result.resetAt / 1000));
        return res.status(429).json({
          success: false,
          error: 'Too many requests. Please try again later.',
          rateLimit: {
            limit: result.limit,
            remaining: 0,
            resetAt: new Date(result.resetAt).toISOString()
          }
        });
      }

      res.setHeader('X-RateLimit-Limit', result.limit);
      res.setHeader('X-RateLimit-Remaining', result.remaining);
      res.setHeader('X-RateLimit-Reset', Math.ceil(result.resetAt / 1000));

      next();
    };
  }

  wrapProcessFn(req, processFn) {
    return async () => {
      const result = this.check(req);
      if (!result.allowed) {
        const err = new Error('Rate limit exceeded');
        err.statusCode = 429;
        err.rateLimit = {
          limit: result.limit,
          remaining: 0,
          resetAt: new Date(result.resetAt).toISOString()
        };
        throw err;
      }
      return processFn();
    };
  }

  getStats() {
    return {
      windowMs: this.windowMs,
      maxPerWindow: this.maxPerWindow,
      trackedClients: this.clients.size
    };
  }
}

module.exports = new RateLimiter();
