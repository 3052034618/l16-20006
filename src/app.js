const express = require('express');
const config = require('./config');
const imagesRoutes = require('./routes/images');
const processRoutes = require('./routes/process');

const app = express();

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: Date.now()
  });
});

app.use('/images', imagesRoutes);
app.use('/process', processRoutes);

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    availableEndpoints: {
      upload: 'POST /images/upload',
      getOriginal: 'GET /images/:id',
      deleteImage: 'DELETE /images/:id',
      updateImage: 'PUT /images/:id',
      process: 'GET /process/:id?w=100&h=100&f=webp',
      processThumbnail: 'GET /process/:id/thumbnail',
      imageInfo: 'GET /process/:id/info'
    }
  });
});

app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message || err);

  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      success: false,
      error: `File too large. Maximum allowed: ${config.upload.maxSize / (1024 * 1024)}MB`
    });
  }

  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({
      success: false,
      error: 'Unexpected field. Use "image" as the field name for file upload.'
    });
  }

  const statusCode = err.statusCode || err.status || 500;
  const errorMessage = err.message || 'Internal server error';

  res.status(statusCode).json({
    success: false,
    error: errorMessage,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

if (require.main === module) {
  app.listen(config.port, () => {
    console.log(`Image Processing Service running on http://localhost:${config.port}`);
    console.log(`Upload directory: ${config.upload.dir}`);
    console.log(`Cache directory: ${config.cache.dir}`);
  });
}

module.exports = app;
