const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const config = require('../config');
const cache = require('../cache');
const processor = require('../processor');

const router = express.Router();

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, config.upload.dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const id = crypto.randomUUID();
    cb(null, `${id}${ext}`);
  }
});

const fileFilter = (req, file, cb) => {
  if (config.upload.allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`Invalid file type: ${file.mimetype}. Allowed: ${config.upload.allowedTypes.join(', ')}`), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: config.upload.maxSize
  }
});

function getImageId(filename) {
  return path.basename(filename, path.extname(filename));
}

router.post('/upload', upload.single('image'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No file uploaded. Please provide an image with field name "image".'
      });
    }

    const imageId = getImageId(req.file.filename);
    const filePath = req.file.path;

    let metadata = null;
    try {
      metadata = await processor.getImageMetadata(filePath);
    } catch (e) {
      // ignore metadata errors
    }

    const fileInfo = {
      id: imageId,
      originalName: req.file.originalname,
      filename: req.file.filename,
      size: req.file.size,
      mimeType: req.file.mimetype,
      url: `/images/${imageId}`,
      metadata: metadata ? {
        width: metadata.width,
        height: metadata.height,
        format: metadata.format
      } : null
    };

    return res.status(201).json({
      success: true,
      data: fileInfo
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const uploadDir = config.upload.dir;

    const files = fs.readdirSync(uploadDir);
    const matchedFile = files.find(f => getImageId(f) === id);

    if (!matchedFile) {
      return res.status(404).json({
        success: false,
        error: 'Image not found'
      });
    }

    const filePath = path.join(uploadDir, matchedFile);
    const ext = path.extname(matchedFile).toLowerCase().slice(1);
    const mimeType = processor.getMimeType(ext);

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'public, max-age=31536000');

    const stream = fs.createReadStream(filePath);
    return stream.pipe(res);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const uploadDir = config.upload.dir;

    const files = fs.readdirSync(uploadDir);
    const matchedFile = files.find(f => getImageId(f) === id);

    if (!matchedFile) {
      return res.status(404).json({
        success: false,
        error: 'Image not found'
      });
    }

    const filePath = path.join(uploadDir, matchedFile);
    fs.unlinkSync(filePath);

    const invalidated = cache.invalidateByImageId(id);

    return res.status(200).json({
      success: true,
      data: {
        deleted: true,
        cacheInvalidated: invalidated
      }
    });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', upload.single('image'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const uploadDir = config.upload.dir;

    const files = fs.readdirSync(uploadDir);
    const matchedFile = files.find(f => getImageId(f) === id);

    if (!matchedFile) {
      return res.status(404).json({
        success: false,
        error: 'Image not found'
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No file uploaded'
      });
    }

    const oldFilePath = path.join(uploadDir, matchedFile);
    fs.unlinkSync(oldFilePath);

    const newExt = path.extname(req.file.filename).toLowerCase();
    const newFilename = `${id}${newExt}`;
    const newFilePath = path.join(uploadDir, newFilename);

    fs.renameSync(req.file.path, newFilePath);

    const invalidated = cache.invalidateByImageId(id);

    let metadata = null;
    try {
      metadata = await processor.getImageMetadata(newFilePath);
    } catch (e) {
      // ignore
    }

    return res.status(200).json({
      success: true,
      data: {
        id,
        filename: newFilename,
        size: req.file.size,
        mimeType: req.file.mimetype,
        url: `/images/${id}`,
        cacheInvalidated: invalidated,
        metadata: metadata ? {
          width: metadata.width,
          height: metadata.height,
          format: metadata.format
        } : null
      }
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
