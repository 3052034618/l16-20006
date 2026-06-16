# Image Processing Service

高性能图片处理服务，支持图片上传、裁剪、缩放、加水印、格式转换、缩略图生成等操作，并通过 URL 参数动态处理并缓存结果。

## 快速开始

```bash
npm install
npm start
```

服务启动于 http://localhost:3000

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /images/upload | 上传图片 |
| GET | /images/:id | 获取原图 |
| PUT | /images/:id | 更新原图 |
| DELETE | /images/:id | 删除图片 |
| GET | /process/:id | 动态处理图片 |
| GET | /process/:id/thumbnail | 生成缩略图 |
| GET | /process/:id/info | 获取图片元信息 |
| GET | /health | 健康检查 |

## 动态处理 URL 参数

```
GET /process/{imageId}?w=800&h=600&f=webp&q=80&watermark=1&wmText=Hello
```

| 参数 | 缩写 | 说明 | 示例 |
|------|------|------|------|
| width / w | w | 目标宽度 | w=800 |
| height / h | h | 目标高度 | h=600 |
| fit | - | 填充模式: cover/contain/fill/inside/outside | fit=contain |
| crop | - | 裁剪位置 | crop=center |
| format / f | f | 输出格式: jpeg/png/webp/gif/tiff/avif | f=webp |
| quality / q | q | 图片质量 1-100 | q=85 |
| watermark / wm | wm | 启用水印 | watermark=1 |
| wmText | - | 水印文字 | wmText=Hello |
| wmSize | - | 水印字号 | wmSize=36 |
| wmOpacity | - | 水印透明度 0-1 | wmOpacity=0.7 |
| wmPosition | - | 水印位置 | wmPosition=southeast |
| thumb / thumbnail | thumb | 生成缩略图(默认200x200) | thumb=1 |
| rotate | - | 旋转角度 | rotate=90 |
| flip | - | 水平翻转 | flip=1 |
| flop | - | 垂直翻转 | flop=1 |
| blur | - | 模糊程度 0.3-1000 | blur=2 |
| sharpen | - | 锐化程度 | sharpen=1 |
| grayscale / bw | bw | 灰度化 | bw=1 |

---

## 核心架构设计

### 1. 动态处理缓存机制 — 避免每次重复处理

核心思路：处理结果 → 两级缓存（内存 LRU + 磁盘文件）。请求到达时：

1. 先查内存缓存 → 命中直接返回
2. 内存未命中 → 查磁盘缓存 → 命中则读入内存并返回
3. 都未命中 → 执行图片处理 → 同时写入内存和磁盘缓存

关键代码见 [cache.js](file:///d:/trae-bz/TraeProjects/20006/src/cache.js) 中的 `getOrProcess 方法。

响应头中返回 `X-Cache-Hit` 和 `X-Cache-Source` 可判断缓存来源。

---

### 2. 缓存 Key 设计 — 涵盖所有处理参数

**缓存 Key 计算公式：

```
key = SHA256(imageId | fileETag | sorted(params)
```

设计要点：

- **imageId**：原图唯一标识
- **fileETag**：文件 size(36进制) + mtimeMs(36进制)，原图更新时自动失效
- **sorted(params)**：所有处理参数按键名排序后序列化，避免参数顺序不同但语义相同的请求命中同一缓存
- **SHA256**：生成 256 位哈希，碰撞概率极低

关键实现：

```javascript
// cacheKey.js
const rawKey = `${imageId}|${fileETag || ''}|${paramStr}';
const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
```

见 [cacheKey.js](file:///d:/trae-bz/TraeProjects/20006/src/cacheKey.js)

磁盘存储路径采用两级目录分片：`cache/{hash前2位}/{完整hash}.{ext}，避免单目录文件过多。

---

### 3. 原图删除/更新时派生缓存失效

**反向索引机制：维护 `imageId → Set<cacheKeyHash>` 的映射关系。

原图删除或更新时：

1. 通过 imageId 查找所有关联的缓存 key
2. 批量从内存 LRU 中删除
3. 遍历磁盘目录删除对应的磁盘文件
4. 清理反向索引

关键代码在 [cache.js](file:///d:/trae-bz/TraeProjects/20006/src/cache.js) 的 `invalidateByImageId` 方法。

上传/更新时自动调用：

```javascript
// routes/images.js - DELETE /images/:id
const invalidated = cache.invalidateByImageId(id);
```

同时，缓存 key 中包含 fileETag，即使未显式失效也会因文件版本变化自动失效（但磁盘缓存（见 [cacheKey.js](file:///d:/trae-bz/TraeProjects/20006/src/cacheKey.js#L56-L63)。

---

### 4. 超大图片内存限制 — 防止巨图撑爆内存

Sharp 本身采用流式处理 + 像素数限制，通过 `limitInputPixels 参数限制输入像素总数（默认约 2.68 亿像素，约 16383x16383）。

```javascript
// processor.js
const pipeline = sharp(originalFilePath, {
  limitInputPixels: config.processing.maxInputPixels,
  failOn: 'none'
});
```

超出限制时抛出 413 错误：

```javascript
// routes/process.js
if (err.message.includes('Input image exceeds')) {
  res.status(413).json({ error: 'Image too large' });
}
```

附加措施：
- `withoutEnlargement: true 防止输出不放大
- 输出不放大
- LRU 缓存按 buffer.length 计算占用内存不超过 maxSize
- 处理中间不放大
- 上传时限制 maxSize 限制

配置见 [config.js](file:///d:/trae-bz/TraeProjects/20006/src/config.js#L22-L28)。

---

### 5. 单飞机制（Single-Flight — 并发请求去重

并发请求同一未缓存结果时，仅第一个请求触发实际处理，后续请求共享同一 Promise。

```javascript
// cache.js
async getOrProcess(cacheKeyHash, ...) {
  if (this.inFlight.has(cacheKeyHash)) {
    return this.inFlight.get(cacheKeyHash); // 返回同一 Promise
  }
  const promise = (async () => {
    try { return await processFn();
    finally { this.inFlight.delete(cacheKeyHash); }
  })();
  this.inFlight.set(cacheKeyHash, promise);
  return promise;
}
```

关键实现见 [cache.js](file:///d:/trae-bz/TraeProjects/20006/src/cache.js#L122-L150)。

---

## 目录结构

```
src/
├── app.js              # Express 应用入口 + 错误处理
├── config.js           # 全局配置
├── cacheKey.js         # 缓存 Key 生成（SHA256）
├── cache.js            # 缓存层（内存+磁盘，单飞机制
├── processor.js        # 图片处理核心（sharp 封装）
└── routes/
│   ├── images.js      # 图片上传/获取/删除/更新
│   └── process.js  # 动态处理接口
uploads/              # 原图存储
cache/                # 处理结果缓存
```

## 示例

```bash
# 上传图片
curl -X POST -F "image=@test.jpg" http://localhost:3000/images/upload

# 动态处理：缩放为 800x600，WebP 格式，质量 80，加水印
curl "http://localhost:3000/process/{id}?w=800&h=600&f=webp&q=80&watermark=1"

# 生成缩略图
curl "http://localhost:3000/process/{id}/thumbnail"

# 删除图片（自动清理所有派生缓存
curl -X DELETE http://localhost:3000/images/{id}
```
