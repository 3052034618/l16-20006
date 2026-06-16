const express = require('express');
const cache = require('../cache');

const router = express.Router();

router.get('/stats', (req, res) => {
  const stats = cache.getStats();
  res.json({
    success: true,
    data: stats
  });
});

router.post('/clear', (req, res) => {
  const { scope, format, olderThan, from, to, imageId } = req.body;
  let invalidated = 0;
  let message = '';

  if (scope === 'all') {
    cache.clearAll();
    return res.json({
      success: true,
      data: {
        cleared: true,
        scope: 'all',
        message: 'All cache cleared (memory + disk)'
      }
    });
  }

  if (scope === 'memory') {
    cache.memoryCache.clear();
    return res.json({
      success: true,
      data: {
        cleared: true,
        scope: 'memory',
        message: 'Memory cache cleared'
      }
    });
  }

  if (imageId) {
    invalidated = cache.invalidateByImageId(imageId);
    message = `Cleared ${invalidated} variants for image ${imageId}`;
  } else if (format) {
    invalidated = cache.invalidateByFormat(format);
    message = `Cleared ${invalidated} files with format ${format}`;
  } else if (olderThan) {
    const ageMs = parseInt(olderThan) * 1000;
    if (isNaN(ageMs) || ageMs <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid olderThan. Use seconds.'
      });
    }
    invalidated = cache.invalidateByOlderThan(ageMs);
    message = `Cleared ${invalidated} files older than ${olderThan} seconds`;
  } else if (from || to) {
    const fromMs = from ? parseInt(from) * 1000 : 0;
    const toMs = to ? parseInt(to) * 1000 : Date.now();
    invalidated = cache.invalidateByTimeRange(fromMs, toMs);
    message = `Cleared ${invalidated} files between ${new Date(fromMs).toISOString()} and ${new Date(toMs).toISOString()}`;
  } else {
    return res.status(400).json({
      success: false,
      error: 'Invalid clear parameters. Use scope=all|memory, or format, or olderThan (seconds), or from/to (unix timestamp seconds), or imageId.'
    });
  }

  cache.forceSaveIndex();

  res.json({
    success: true,
    data: {
      cleared: true,
      invalidatedCount: invalidated,
      message
    }
  });
});

router.delete('/image/:id', (req, res) => {
  const { id } = req.params;
  const invalidated = cache.invalidateByImageId(id);
  cache.forceSaveIndex();

  res.json({
    success: true,
    data: {
      imageId: id,
      invalidatedCount: invalidated,
      message: invalidated > 0
        ? `Invalidated ${invalidated} cached variants for image ${id}`
        : `No cached variants found for image ${id}`
    }
  });
});

router.get('/image/:id', (req, res) => {
  const { id } = req.params;
  const info = cache.getImageCacheInfo(id);

  res.json({
    success: true,
    data: info
  });
});

router.get('/images/ranking', (req, res) => {
  const stats = cache.getStats();
  res.json({
    success: true,
    data: {
      byCount: stats.ranking.topByCount,
      totalImages: stats.disk.imageCount,
      totalVariants: stats.disk.itemCount
    }
  });
});

module.exports = router;
