const sharp = require('sharp');
const config = require('./config');

const VALID_FORMATS = ['jpeg', 'jpg', 'png', 'webp', 'gif', 'tiff', 'avif'];
const VALID_FIT_MODES = ['cover', 'contain', 'fill', 'inside', 'outside'];
const VALID_POSITIONS = [
  'north', 'northeast', 'east', 'southeast',
  'south', 'southwest', 'west', 'northwest', 'center'
];

function validateParams(params) {
  const errors = [];

  const w = params.w || params.width;
  const h = params.h || params.height;

  if (w) {
    const width = parseInt(w);
    if (isNaN(width) || width <= 0 || width > config.processing.maxWidth) {
      errors.push(`Invalid width: ${w}. Max allowed: ${config.processing.maxWidth}`);
    }
  }

  if (h) {
    const height = parseInt(h);
    if (isNaN(height) || height <= 0 || height > config.processing.maxHeight) {
      errors.push(`Invalid height: ${h}. Max allowed: ${config.processing.maxHeight}`);
    }
  }

  const format = params.f || params.format;
  if (format && !VALID_FORMATS.includes(format.toLowerCase())) {
    errors.push(`Invalid format: ${format}. Supported: ${VALID_FORMATS.join(', ')}`);
  }

  const fit = params.fit;
  if (fit && !VALID_FIT_MODES.includes(fit)) {
    errors.push(`Invalid fit mode: ${fit}. Supported: ${VALID_FIT_MODES.join(', ')}`);
  }

  const q = params.q || params.quality;
  if (q) {
    const quality = parseInt(q);
    if (isNaN(quality) || quality < 1 || quality > 100) {
      errors.push(`Invalid quality: ${q}. Must be 1-100`);
    }
  }

  return errors;
}

function parseOutputFormat(params, originalFormat) {
  const fmt = (params.f || params.format || originalFormat || 'png').toLowerCase();
  return fmt === 'jpg' ? 'jpeg' : fmt;
}

function applyResize(sharpInstance, params) {
  const w = params.w || params.width;
  const h = params.h || params.height;
  const fit = params.fit || 'cover';
  const crop = params.crop;

  if (!w && !h && !params.thumb && !params.thumbnail) {
    return sharpInstance;
  }

  let width = w ? parseInt(w) : null;
  let height = h ? parseInt(h) : null;

  if ((params.thumb || params.thumbnail) && !width && !height) {
    width = 200;
    height = 200;
  }

  const resizeOptions = {
    fit: VALID_FIT_MODES.includes(fit) ? fit : 'cover',
    withoutEnlargement: true
  };

  if (crop) {
    resizeOptions.position = crop;
  }

  return sharpInstance.resize(width, height, resizeOptions);
}

function applyTransforms(sharpInstance, params) {
  let instance = sharpInstance;

  if (params.rotate) {
    const angle = parseInt(params.rotate);
    if (!isNaN(angle)) {
      instance = instance.rotate(angle);
    }
  }

  if (params.flip) {
    instance = instance.flip();
  }

  if (params.flop) {
    instance = instance.flop();
  }

  if (params.blur) {
    const sigma = parseFloat(params.blur);
    if (!isNaN(sigma) && sigma >= 0.3 && sigma <= 1000) {
      instance = instance.blur(sigma);
    }
  }

  if (params.sharpen) {
    const sigma = parseFloat(params.sharpen);
    if (!isNaN(sigma)) {
      instance = instance.sharpen(sigma);
    }
  }

  if (params.grayscale || params.bw) {
    instance = instance.grayscale();
  }

  return instance;
}

function applyQuality(sharpInstance, params, format) {
  const q = params.q || params.quality;
  const quality = q ? parseInt(q) : 80;

  switch (format) {
    case 'jpeg':
      return sharpInstance.jpeg({ quality, mozjpeg: true });
    case 'png':
      return sharpInstance.png({ quality, compressionLevel: 9 });
    case 'webp':
      return sharpInstance.webp({ quality });
    case 'avif':
      return sharpInstance.avif({ quality });
    case 'tiff':
      return sharpInstance.tiff({ quality });
    default:
      return sharpInstance;
  }
}

async function applyWatermark(imageBuffer, params) {
  if (!params.watermark && !params.wm) {
    return imageBuffer;
  }

  const text = params.wmText || config.watermark.defaultText;
  const fontSize = parseInt(params.wmSize) || config.watermark.defaultFontSize;
  const opacity = parseFloat(params.wmOpacity) || config.watermark.defaultOpacity;
  const position = params.wmPosition || config.watermark.defaultPosition;

  const svgWatermark = `
    <svg xmlns="http://www.w3.org/2000/svg" width="800" height="200">
      <text x="50%" y="50%" 
            font-family="Arial, sans-serif" 
            font-size="${fontSize}" 
            fill="rgba(255, 255, 255, ${opacity})"
            stroke="rgba(0, 0, 0, ${opacity * 0.5})"
            stroke-width="1"
            text-anchor="middle" 
            dominant-baseline="middle">${text}</text>
    </svg>
  `;

  const gravityMap = {
    'north': 'north',
    'northeast': 'northeast',
    'east': 'east',
    'southeast': 'southeast',
    'south': 'south',
    'southwest': 'southwest',
    'west': 'west',
    'northwest': 'northwest',
    'center': 'center'
  };

  const gravity = gravityMap[position.toLowerCase()] || 'southeast';

  return sharp(imageBuffer)
    .composite([{
      input: Buffer.from(svgWatermark),
      gravity: gravity,
      tile: false
    }])
    .toBuffer();
}

async function processImage(originalFilePath, params) {
  const validationErrors = validateParams(params);
  if (validationErrors.length > 0) {
    throw new Error(`Invalid parameters: ${validationErrors.join('; ')}`);
  }

  const pipeline = sharp(originalFilePath, {
    limitInputPixels: config.processing.limitInputPixels
      ? config.processing.maxInputPixels
      : false,
    failOn: 'none',
    density: 72
  });

  let instance = pipeline;
  instance = applyResize(instance, params);
  instance = applyTransforms(instance, params);

  const originalFormat = await getImageFormat(originalFilePath);
  const outputFormat = parseOutputFormat(params, originalFormat);
  instance = applyQuality(instance, params, outputFormat);

  let buffer = await instance.toFormat(outputFormat).toBuffer();

  buffer = await applyWatermark(buffer, params);

  return {
    buffer,
    format: outputFormat,
    mimeType: getMimeType(outputFormat)
  };
}

async function getImageFormat(filePath) {
  try {
    const metadata = await sharp(filePath).metadata();
    return metadata.format || 'png';
  } catch (e) {
    return 'png';
  }
}

function getMimeType(format) {
  const map = {
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'webp': 'image/webp',
    'gif': 'image/gif',
    'tiff': 'image/tiff',
    'avif': 'image/avif'
  };
  return map[format] || 'image/png';
}

async function getImageMetadata(filePath) {
  return sharp(filePath).metadata();
}

module.exports = {
  processImage,
  validateParams,
  parseOutputFormat,
  getImageFormat,
  getMimeType,
  getImageMetadata,
  VALID_FORMATS,
  VALID_FIT_MODES
};
