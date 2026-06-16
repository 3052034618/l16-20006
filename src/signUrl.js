const crypto = require('crypto');
const config = require('./config');

function buildSignString(path, params, excludeKeys = ['sign']) {
  const keys = Object.keys(params).filter(k => !excludeKeys.includes(k)).sort();
  const queryStr = keys.map(k => `${k}=${params[k]}`).join('&');
  return `${path}?${queryStr}`;
}

function signUrl(path, params, secret) {
  const signSecret = secret || config.security.signSecret;
  const signStr = buildSignString(path, params);
  const raw = `${signStr}${signSecret}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function generateSignedUrl(baseUrl, imageId, params, options = {}) {
  const secret = options.secret || config.security.signSecret;
  const expiresIn = options.expiresIn || config.security.signExpireDefault;
  const expires = Math.floor(Date.now() / 1000) + expiresIn;
  const suffix = options.suffix || '';

  const fullParams = { ...params, expires };
  const path = suffix ? `/process/${imageId}/${suffix}` : `/process/${imageId}`;
  const sign = signUrl(path, fullParams, secret);
  fullParams.sign = sign;

  const queryStr = Object.keys(fullParams)
    .sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(fullParams[k])}`)
    .join('&');

  return `${baseUrl}${path}?${queryStr}`;
}

function verifySignMiddleware(req, res, next) {
  if (!config.security.signEnabled) {
    return next();
  }

  const { sign, expires } = req.query;

  if (!sign) {
    return res.status(403).json({
      success: false,
      error: 'Missing signature. URL must be signed with sign parameter.'
    });
  }

  if (!expires) {
    return res.status(403).json({
      success: false,
      error: 'Missing expires parameter. All signed URLs must include an expiration time.'
    });
  }

  const expireTime = parseInt(expires);
  if (isNaN(expireTime)) {
    return res.status(403).json({
      success: false,
      error: 'Invalid expires parameter. Must be a Unix timestamp in seconds.'
    });
  }

  if (Math.floor(Date.now() / 1000) > expireTime) {
    return res.status(410).json({
      success: false,
      error: 'URL has expired'
    });
  }

  const fullPath = (req.baseUrl || '') + req.path;
  const expectedSign = signUrl(fullPath, req.query);

  if (sign !== expectedSign) {
    return res.status(403).json({
      success: false,
      error: 'Invalid signature'
    });
  }

  next();
}

module.exports = {
  signUrl,
  generateSignedUrl,
  verifySignMiddleware,
  buildSignString
};
