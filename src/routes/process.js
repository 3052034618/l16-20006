const express = require('express');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const cache = require('../cache');
const processor = require('../processor');
const cacheKeyUtil = require('../cacheKey');

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

router.get('/:id', async (req, res, next) => {
  try {
    const { id: imageId } = req.params;
    const params = req.query;

    const originalFilePath = findOriginalFile(imageId);
    if (!originalFilePath) {
      return res.status(404).json({
        success: false,
        error: 'Original image not found'
      });
    }

    const validationErrors = processor.validateParams(params);
    if (validationErrors.length > 0) {
      return res.status(400).json({
        success: false,
        error: validationErrors.join('; ')
      });
    }

    const originalFormat = await processor.getImageFormat(originalFilePath);
    const outputFormat = processor.parseOutputFormat(params, originalFormat);
    const cacheFileInfo = cacheKeyUtil.getCacheFilePath(imageId, params, originalFilePath, outputFormat);

    const cacheKeyHash = cacheFileInfo.key;
    const cacheFilePath = cacheFileInfo.fullPath;

    const result = await cache.getOrProcess(
      cacheKeyHash,
      imageId,
      cacheFilePath,
      async () => {
        const processed = await processor.processImage(originalFilePath, params);
        return processed.buffer;
      }
    );

    const mimeType = processor.getMimeType(outputFormat);

    res.setHeader('Content-Type', mimeType);
    res.setHeader('X-Cache-Source', result.source);
    res.setHeader('X-Cache-Hit', result.fromCache ? 'true' : 'false');

    if (result.fromCache) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=31536000');
    }

    return res.send(result.data);
  } catch (err) {
    if (err.message && err.message.includes('Input image exceeds')) {
      return res.status(413).json({
        success: false,
        error: 'Image too large. Maximum supported pixel count exceeded.'
      });
    }
    next(err);
  }
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

router.get('/:id/thumbnail', async (req, res, next) => {
  req.query.thumb = '1';
  if (!req.query.w && !req.query.width) {
    req.query.w = '200';
    req.query.h = '200';
  }
  next();
});

module.exports = router;
