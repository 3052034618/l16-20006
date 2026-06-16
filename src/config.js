const path = require('path');
const fs = require('fs');

const config = {
  port: process.env.PORT || 3000,

  upload: {
    dir: path.resolve(__dirname, '../uploads'),
    maxSize: 50 * 1024 * 1024,
    allowedTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/tiff', 'image/bmp']
  },

  cache: {
    dir: path.resolve(__dirname, '../cache'),
    maxSize: 1024 * 1024 * 1024,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    memoryMaxItems: 500
  },

  processing: {
    maxWidth: 8192,
    maxHeight: 8192,
    maxInputPixels: 268402689,
    concurrency: 0,
    limitInputPixels: true
  },

  watermark: {
    defaultText: '© ImageService',
    defaultFontSize: 48,
    defaultOpacity: 0.5,
    defaultPosition: 'southeast'
  },

  security: {
    signSecret: process.env.SIGN_SECRET || 'image-service-default-secret-key',
    signEnabled: true,
    signExpireDefault: 3600
  }
};

function ensureDirs() {
  [config.upload.dir, config.cache.dir].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
}

ensureDirs();

module.exports = config;
