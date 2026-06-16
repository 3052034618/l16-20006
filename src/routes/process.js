const express = require('express');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const cache = require('../cache');
const processor = require('../processor');
const cacheKeyUtil = require('../cacheKey');
const { verifySignMiddleware } = require('../signUrl');
const audit = require('../audit');
const rateLimiter = require('../rateLimiter');

const router = express.Router();

function findOriginalFile(imageId) {
  const uploadDir = config.upload.dir;
  if (!fs.existsSync(uploadDir)) return null;

  const files = fs.readdirSync(uploadDir);
  for (const file of files) {
    const id = path.basename(file, path.extname(file));
    if (id === imageId) {
      return path.join(uploadDir, file);
    }
  }
  return null;
}

function buildETag(cacheKeyHash) {
  return `"${cacheKeyHash}"`;
}

function checkConditionalRequest(req, res, cacheKeyHash, lastModifiedMs) {
  const ifNoneMatch = req.headers['if-none-match'];
  const ifModifiedSince = req.headers['if-modified-since'];

  const eTag = buildETag(cacheKeyHash);

  if (ifNoneMatch && ifNoneMatch === eTag) {
    res.setHeader('ETag', eTag);
    if (lastModifiedMs) {
      res.setHeader('Last-Modified', new Date(lastModifiedMs).toUTCString());
    }
    res.status(304).end();
    return true;
  }

  if (ifModifiedSince && lastModifiedMs) {
    const modifiedSinceTime = new Date(ifModifiedSince).getTime();
    const lastModifiedSec = Math.floor(lastModifiedMs / 1000) * 1000;
    if (!isNaN(modifiedSinceTime) && lastModifiedSec <= modifiedSinceTime) {
      res.setHeader('ETag', eTag);
      res.setHeader('Last-Modified', new Date(lastModifiedMs).toUTCString());
      res.status(304).end();
      return true;
    }
  }

  return false;
}

async function handleProcessRequest(req, res, next, extraParams = {}) {
  try {
    const { id: imageId } = req.params;
    const params = { ...req.query, ...extraParams };

    const originalFilePath = findOriginalFile(imageId);
    if (!originalFilePath) {
      return res.status(404).json({
        success: false,
        error: 'Original image not found'
      });
    }

    const { params: effectiveParams, presetName } = processor.applyPreset(params);

    const validationErrors = processor.validateParams(effectiveParams);
    if (validationErrors.length > 0) {
      return res.status(400).json({
        success: false,
        error: validationErrors.join('; ')
      });
    }

    const originalFormat = await processor.getImageFormat(originalFilePath);
    const outputFormat = processor.parseOutputFormat(effectiveParams, originalFormat);
    const cacheFileInfo = cacheKeyUtil.getCacheFilePath(imageId, effectiveParams, originalFilePath, outputFormat);

    const cacheKeyHash = cacheFileInfo.key;
    const cacheFilePath = cacheFileInfo.fullPath;

    const diskMeta = cache.getDiskMeta(cacheKeyHash);
    if (diskMeta && checkConditionalRequest(req, res, cacheKeyHash, diskMeta.createdAt)) {
      return;
    }

    const result = await cache.getOrProcess(
      cacheKeyHash,
      imageId,
      cacheFilePath,
      rateLimiter.wrapProcessFn(req, async () => {
        const processed = await processor.processImage(originalFilePath, params);
        return processed.buffer;
      }),
      effectiveParams
    );

    const mimeType = processor.getMimeType(outputFormat);
    const eTag = buildETag(cacheKeyHash);

    const meta = cache.getDiskMeta(cacheKeyHash);
    const lastModified = meta && meta.createdAt ? meta.createdAt : Date.now();

    if (checkConditionalRequest(req, res, cacheKeyHash, lastModified)) {
      return;
    }

    res.setHeader('Content-Type', mimeType);
    res.setHeader('ETag', eTag);
    res.setHeader('Last-Modified', new Date(lastModified).toUTCString());
    res.setHeader('X-Cache-Source', result.source);
    res.setHeader('X-Cache-Hit', result.fromCache ? 'true' : 'false');

    if (presetName) {
      res.setHeader('X-Preset', presetName);
    }

    if (result.fromCache) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=31536000');
    }

    return res.send(result.data);
  } catch (err) {
    if (err.statusCode === 429) {
      if (err.rateLimit) {
        res.setHeader('X-RateLimit-Limit', err.rateLimit.limit);
        res.setHeader('X-RateLimit-Remaining', 0);
        res.setHeader('X-RateLimit-Reset', Math.floor(new Date(err.rateLimit.resetAt).getTime() / 1000));
      }
      return res.status(429).json({
        success: false,
        error: 'Too many processing requests. Please try again later.',
        rateLimit: err.rateLimit
      });
    }

    if (err.message && err.message.includes('Input image exceeds')) {
      return res.status(413).json({
        success: false,
        error: 'Image too large. Maximum supported pixel count exceeded.'
      });
    }
    next(err);
  }
}

router.use(audit.createMiddleware());
router.use(verifySignMiddleware);

router.get('/:id/thumbnail', (req, res, next) => {
  handleProcessRequest(req, res, next, { preset: 'thumbnail' });
});

router.get('/:id/info', async (req, res, next) => {
  try {
    const { id: imageId } = req.params;
    const originalFilePath = findOriginalFile(imageId);

    if (!originalFilePath) {
      return res.status(404).json({
        success: false,
        error: 'Original image not found'
      });
    }

    const metadata = await processor.getImageMetadata(originalFilePath);
    const stat = fs.statSync(originalFilePath);

    return res.json({
      success: true,
      data: {
        id: imageId,
        format: metadata.format,
        width: metadata.width,
        height: metadata.height,
        size: stat.size,
        channels: metadata.channels,
        density: metadata.density,
        hasAlpha: metadata.hasAlpha,
        orientation: metadata.orientation,
        file: path.basename(originalFilePath)
      }
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/presets', (req, res) => {
  res.json({
    success: true,
    data: {
      presets: Object.keys(processor.PRESETS),
      details: processor.PRESETS
    }
  });
});

router.get('/:id', (req, res, next) => {
  handleProcessRequest(req, res, next);
});

module.exports = router;
