const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const PROCESSING_PARAMS = [
  'w', 'h', 'width', 'height',
  'fit', 'crop',
  'q', 'quality',
  'f', 'format',
  'resize',
  'watermark',
  'wm',
  'wmText',
  'wmSize',
  'wmOpacity',
  'wmPosition',
  'thumb',
  'thumbnail',
  'rotate',
  'flip',
  'flop',
  'blur',
  'sharpen',
  'grayscale',
  'bw'
];

function normalizeParams(params) {
  const normalized = {};

  if (!params) return normalized;

  if (params.w || params.width) normalized.w = parseInt(params.w || params.width);
  if (params.h || params.height) normalized.h = parseInt(params.h || params.height);
  if (params.fit) normalized.fit = String(params.fit);
  if (params.crop) normalized.crop = String(params.crop);
  if (params.q || params.quality) normalized.q = parseInt(params.q || params.quality);
  if (params.f || params.format) normalized.f = String(params.f || params.format);
  if (params.watermark || params.wm) normalized.watermark = '1';
  if (params.wmText) normalized.wmText = String(params.wmText);
  if (params.wmSize) normalized.wmSize = parseInt(params.wmSize);
  if (params.wmOpacity) normalized.wmOpacity = parseFloat(params.wmOpacity);
  if (params.wmPosition) normalized.wmPosition = String(params.wmPosition);
  if (params.thumb || params.thumbnail) normalized.thumb = '1';
  if (params.rotate) normalized.rotate = parseInt(params.rotate);
  if (params.flip) normalized.flip = '1';
  if (params.flop) normalized.flop = '1';
  if (params.blur) normalized.blur = parseFloat(params.blur);
  if (params.sharpen) normalized.sharpen = parseFloat(params.sharpen);
  if (params.grayscale || params.bw) normalized.grayscale = '1';

  return normalized;
}

function getFileETag(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.size.toString(36)}-${stat.mtimeMs.toString(36)}`;
  } catch (e) {
    return null;
  }
}

function generateCacheKey(imageId, params, originalFilePath) {
  const normalized = normalizeParams(params);
  const sortedKeys = Object.keys(normalized).sort();
  const paramStr = sortedKeys.map(k => `${k}=${normalized[k]}`).join('&');
  const fileETag = getFileETag(originalFilePath);
  const rawKey = `${imageId}|${fileETag || ''}|${paramStr}`;

  const hash = crypto.createHash('sha256').update(rawKey).digest('hex');

  return {
    hash,
    paramStr,
    fileETag,
    imageId
  };
}

function getCachePath(cacheKey) {
  const subDir = cacheKey.hash.substring(0, 2);
  return path.join(config.cache.dir, subDir);
}

function getCacheFilePath(imageId, params, originalFilePath, outputFormat) {
  const cacheKey = generateCacheKey(imageId, params, originalFilePath);
  const cacheDir = getCachePath(cacheKey);
  const ext = outputFormat || 'png';
  return {
    dir: cacheDir,
    fullPath: path.join(cacheDir, `${cacheKey.hash}.${ext}`),
    key: cacheKey.hash
  };
}

function getImageIdFromCacheKey(cacheKey) {
  return cacheKey.imageId;
}

module.exports = {
  generateCacheKey,
  normalizeParams,
  getCachePath,
  getCacheFilePath,
  getImageIdFromCacheKey,
  getFileETag
};
