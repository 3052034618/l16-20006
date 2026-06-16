# Image Processing Service

高性能图片处理网关服务，支持图片上传、裁剪、缩放、加水印、格式转换、缩略图生成等操作，并通过 URL 参数动态处理并缓存结果。

## 快速开始

```bash
npm install
npm start
```

服务启动于 http://localhost:3000

## API 接口总览

### 图片管理

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /images/upload | 上传图片 |
| GET | /images/:id | 获取原图 |
| PUT | /images/:id | 更新原图（自动清理派生缓存） |
| DELETE | /images/:id | 删除图片（自动清理派生缓存） |

### 动态处理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /process/:id | 动态处理图片（支持所有参数） |
| GET | /process/:id/thumbnail | 快速获取缩略图（200x200） |
| GET | /process/:id/presets | 查看可用预设列表 |
| GET | /process/:id/info | 获取图片元信息 |

### 缓存管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /cache/admin/stats | 缓存统计（命中率、占用、派生数量） |
| POST | /cache/admin/clear | 清理缓存（scope=all/memory） |
| GET | /cache/admin/image/:id | 查看某图的派生缓存列表 |
| DELETE | /cache/admin/image/:id | 清理某图的所有派生缓存 |

### 其他

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /health | 健康检查 |

---

## 动态处理参数

```
GET /process/{imageId}?preset=medium&watermark=1&wmText=Hello
```

### 预设（preset）

内置常用规格，一键套用尺寸、裁剪、格式、质量：

| 预设名 | 尺寸 | 模式 | 格式 | 质量 | 说明 |
|--------|------|------|------|------|------|
| `small` | 320×240 | cover | jpeg | 75 | 小图 |
| `medium` | 800×600 | cover | jpeg | 85 | 中图 |
| `large` | 1920×1080 | inside | jpeg | 90 | 大图 |
| `avatar` | 200×200 | cover center | jpeg | 85 | 头像 |
| `banner` | 1200×300 | cover center | jpeg | 85 | 横幅 |
| `thumbnail` | 200×200 | cover | jpeg | 80 | 缩略图 |
| `webp-small` | 320×240 | cover | webp | 70 | WebP小图 |
| `webp-medium` | 800×600 | cover | webp | 80 | WebP中图 |

预设中的参数可被同名查询参数覆盖，例如 `?preset=medium&q=90` 使用 medium 的尺寸但质量为 90。

响应头 `X-Preset` 表示命中的预设名。

### 完整参数列表

| 参数 | 缩写 | 说明 | 示例 |
|------|------|------|------|
| `preset` | - | 处理预设 | `preset=avatar` |
| `width` / `w` | `w` | 目标宽度 | `w=800` |
| `height` / `h` | `h` | 目标高度 | `h=600` |
| `fit` | - | 填充模式: cover/contain/fill/inside/outside | `fit=contain` |
| `crop` | - | 裁剪位置 | `crop=center` |
| `format` / `f` | `f` | 输出格式: jpeg/jpg/png/webp/gif/tiff/avif（大小写不敏感，jpg=jpeg） | `f=webp` |
| `quality` / `q` | `q` | 图片质量 1-100 | `q=85` |
| `watermark` / `wm` | `wm` | 启用水印 | `watermark=1` |
| `wmText` | - | 水印文字（支持中文、emoji、特殊字符） | `wmText=你好&copy;` |
| `wmSize` | - | 水印字号 | `wmSize=36` |
| `wmOpacity` | - | 水印透明度 0-1 | `wmOpacity=0.7` |
| `wmPosition` | - | 水印位置: north/northeast/.../center | `wmPosition=southeast` |
| `thumb` / `thumbnail` | `thumb` | 缩略图模式（默认200×200） | `thumb=1` |
| `rotate` | - | 旋转角度 | `rotate=90` |
| `flip` | - | 水平翻转 | `flip=1` |
| `flop` | - | 垂直翻转 | `flop=1` |
| `blur` | - | 模糊程度 0.3-1000 | `blur=2` |
| `sharpen` | - | 锐化程度 | `sharpen=1` |
| `grayscale` / `bw` | `bw` | 灰度化 | `bw=1` |

---

## 核心架构设计

### 1. 动态处理缓存机制 — 避免每次重复处理

两级缓存架构（内存 LRU + 磁盘文件）：

1. **内存 LRU 缓存**：最快命中，最多 500 项，按字节数限制容量
2. **磁盘文件缓存**：持久化，TTL 7 天，按 hash 前 2 位分目录
3. 查询顺序：内存 → 磁盘 → 实际处理

响应头：
- `X-Cache-Hit`: `true` / `false`
- `X-Cache-Source`: `memory` / `disk` / `processed`

关键代码见 [cache.js](file:///d:/trae-bz/TraeProjects/20006/src/cache.js#L133-L170) 中的 `getOrProcess` 方法。

---

### 2. 缓存 Key 设计 — 涵盖所有处理参数

**公式**：`SHA256(imageId | fileETag | sorted(normalizedParams))`

| 组成部分 | 作用 |
|---|---|
| `imageId` | 唯一标识原图 |
| `fileETag` | `size(36进制) + mtimeMs(36进制)`，原图变化自动失效 |
| `sorted(normalizedParams)` | 规范化后按键排序，消除参数顺序、大小写、格式别名差异 |
| `SHA256` | 256 位哈希，碰撞概率极低 |

**参数规范化**（关键）：
- 格式：`WEBP` → `webp`，`jpg` → `jpeg` → 等价格式共享同一份缓存
- 别名合并：`w` / `width` → 统一为 `w`
- 布尔值：`watermark=1` 统一存储

关键实现见 [cacheKey.js](file:///d:/trae-bz/TraeProjects/20006/src/cacheKey.js#L29-L54)。

磁盘存储：`cache/{hash前2位}/{hash}.{ext}`，避免单目录文件过多。

---

### 3. 原图删除/更新时派生缓存失效

**反向索引 + 文件 ETag 双重保险**：

**主动失效**（删除/更新时）：
- 维护 `imageId → Set<cacheKeyHash>` 反向索引
- 删除时批量清理内存 LRU + 磁盘文件

**被动失效**（缓存 Key 中已包含 fileETag）：
- 原图内容变化后，ETag 改变
- 旧缓存 Key 自动不再命中

关键代码：
- [cache.js - invalidateByImageId](file:///d:/trae-bz/TraeProjects/20006/src/cache.js#L172-L203)
- [routes/images.js - DELETE /images/:id](file:///d:/trae-bz/TraeProjects/20006/src/routes/images.js#L118-L134)

---

### 4. 超大图片内存限制 — 防止巨图撑爆内存

Sharp 流式处理 + 像素数硬限制：

```javascript
// processor.js
sharp(originalFilePath, {
  limitInputPixels: 268402689,  // 约 16383×16383
  failOn: 'none'
})
```

超出限制返回 413。其他防护措施：
- `withoutEnlargement: true` — 禁止放大
- LRU 缓存按 `buffer.length` 计算占用，不超过 maxSize
- 上传时 50MB 文件大小限制
- 输出尺寸最大 8192×8192

配置见 [config.js](file:///d:/trae-bz/TraeProjects/20006/src/config.js#L22-L28)。

---

### 5. 单飞机制（Single-Flight） — 并发去重

并发请求同一未缓存结果时，仅首个请求执行处理，其余共享同一 Promise：

```javascript
// cache.js
if (this.inFlight.has(cacheKeyHash)) {
  return this.inFlight.get(cacheKeyHash);  // 共享 Promise
}
const promise = (async () => {
  try { return await processFn(); }
  finally { this.inFlight.delete(cacheKeyHash); }
})();
this.inFlight.set(cacheKeyHash, promise);
return promise;
```

统计项 `singleFlightSaved` 记录单飞机制节省的处理次数。

关键实现见 [cache.js](file:///d:/trae-bz/TraeProjects/20006/src/cache.js#L133-L170)。

---

### 6. 处理预设 — 常用规格一键套用

预设定义尺寸、裁剪模式、格式、质量，调用时用 `preset=xxx` 即可套用。预设参数可被同名查询参数覆盖。

预设展开后的参数参与缓存 Key 计算，因此 `preset=medium` 和 `w=800&h=600&q=85&f=jpeg` 命中同一份缓存。

响应头 `X-Preset` 返回命中的预设名。

关键代码：
- [processor.js - PRESETS 定义](file:///d:/trae-bz/TraeProjects/20006/src/processor.js#L11-L70)
- [processor.js - applyPreset](file:///d:/trae-bz/TraeProjects/20006/src/processor.js#L72-L91)

---

### 7. 水印特殊字符安全

水印文字经过完整的 **XML 实体转义**，支持：
- 特殊字符：`&`、`<`、`>`、`"`、`'`
- 中文、日文等多字节字符
- Emoji 表情

```javascript
// processor.js - escapeXml
function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
```

此外 SVG 画布尺寸根据文字内容动态计算（中文按全角宽度估算），避免文字被截断。

关键代码见 [processor.js - applyWatermark](file:///d:/trae-bz/TraeProjects/20006/src/processor.js#L251-L300)。

---

### 8. 缓存管理 & 运维接口

#### 查看缓存统计

```
GET /cache/admin/stats
```

返回示例：
```json
{
  "success": true,
  "data": {
    "memory": { "itemCount": 42, "sizeBytes": 5242880, "sizeMB": "5.00" },
    "disk": { "derivedCount": 128 },
    "stats": {
      "totalHits": 1024,
      "memoryHits": 800,
      "diskHits": 200,
      "misses": 24,
      "processed": 24,
      "singleFlightSaved": 12,
      "hitRate": "97.71%"
    },
    "uptime": { "seconds": 3600, "startedAt": "2026-06-16T17:43:26.665Z" },
    "inFlight": 0,
    "imageIndexSize": 56
  }
}
```

#### 清理缓存

```bash
# 全部清理（内存+磁盘）
curl -X POST -H "Content-Type: application/json" \
  -d '{"scope":"all"}' \
  http://localhost:3000/cache/admin/clear

# 只清内存
curl -X POST -H "Content-Type: application/json" \
  -d '{"scope":"memory"}' \
  http://localhost:3000/cache/admin/clear
```

#### 按图片 ID 管理

```bash
# 查看某图的派生缓存
curl http://localhost:3000/cache/admin/image/{id}

# 清理某图的所有派生缓存
curl -X DELETE http://localhost:3000/cache/admin/image/{id}
```

---

## 目录结构

```
src/
├── app.js                  # Express 应用入口 + 错误处理
├── config.js               # 全局配置
├── cacheKey.js             # 缓存 Key 生成（SHA256 + 参数规范化）
├── cache.js                # 缓存层（内存 LRU + 磁盘 + 单飞）
├── processor.js            # 图片处理核心（sharp 封装 + 预设 + 水印）
└── routes/
    ├── images.js           # 图片上传 / CRUD
    ├── process.js          # 动态处理接口
    └── cacheAdmin.js       # 缓存管理接口
uploads/                    # 原图存储
cache/                      # 处理结果磁盘缓存
```

---

## 使用示例

```bash
# 1. 上传图片
curl -X POST -F "image=@photo.jpg" http://localhost:3000/images/upload
# 返回: { "success": true, "data": { "id": "xxx", "url": "/images/xxx" } }

# 2. 使用预设快速处理
curl "http://localhost:3000/process/xxx?preset=avatar"
# 响应头 X-Preset: avatar

# 3. 自定义参数处理
curl "http://localhost:3000/process/xxx?w=800&h=600&f=webp&q=80&watermark=1&wmText=你好"

# 4. 快速获取缩略图
curl "http://localhost:3000/process/xxx/thumbnail"

# 5. 查看缓存统计
curl http://localhost:3000/cache/admin/stats

# 6. 删除图片（自动清理所有派生缓存）
curl -X DELETE http://localhost:3000/images/xxx
```
