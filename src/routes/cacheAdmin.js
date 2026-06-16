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
  const { scope } = req.body;

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

  return res.status(400).json({
    success: false,
    error: 'Invalid scope. Use "all" or "memory". Or use DELETE /cache/image/:id to clear by image ID.'
  });
});

router.delete('/image/:id', (req, res) => {
  const { id } = req.params;
  const invalidated = cache.invalidateByImageId(id);

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
  const cacheKeys = cache.imageCacheIndex.get(id);

  res.json({
    success: true,
    data: {
      imageId: id,
      hasCachedVariants: !!cacheKeys,
      variantCount: cacheKeys ? cacheKeys.size : 0,
      variants: cacheKeys ? Array.from(cacheKeys) : []
    }
  });
});

module.exports = router;
