# Image Processing Service

企业级图片处理网关服务，支持图片上传、裁剪、缩放、加水印、格式转换、缩略图生成等操作，并通过 URL 参数动态处理并缓存结果。具备签名防刷、CDN 友好响应、丰富的缓存管理能力，可直接上线。

## 快速开始

```bash
npm install
npm start
```

服务启动于 http://localhost:3000

启用签名验证：
```bash
SIGN_ENABLED=true SIGN_SECRET=your-secret-key npm start
```

---

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
| GET | /process/:id/thumbnail | 快速获取缩略图（200×200，走 thumbnail 预设） |
| GET | /process/:id/presets | 查看可用预设列表 |
| GET | /process/:id/info | 获取图片元信息 |

### 缓存管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /cache/admin/stats | 缓存统计（命中率、占用、格式分布、派生图排行榜） |
| POST | /cache/admin/clear | 清理缓存（多种策略） |
| GET | /cache/admin/image/:id | 查看某图的派生缓存详情 |
| DELETE | /cache/admin/image/:id | 清理某图的所有派生缓存 |
| GET | /cache/admin/images/ranking | 派生图数量排行榜 |

### 签名 & 工具

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /sign-url | 生成签名 URL（调试用） |
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
| `webp-small` | 320×240 | cover | webp | 70 | WebP 小图 |
| `webp-medium` | 800×600 | cover | webp | 80 | WebP 中图 |

**预设 + 自定义参数**：预设参数可被同名查询参数覆盖，例如 `?preset=medium&q=90` 使用 medium 的尺寸但质量为 90。

**响应头**：`X-Preset` 表示命中的预设名。

**缓存一致性**：预设展开后的参数参与缓存 Key 计算，因此 `preset=medium` 和 `w=800&h=600&q=85&f=jpeg` 命中同一份缓存。

### 完整参数列表

| 参数 | 缩写 | 说明 | 示例 |
|------|------|------|------|
| `preset` | - | 处理预设 | `preset=avatar` |
| `width` / `w` | `w` | 目标宽度 | `w=800` |
| `height` / `h` | `h` | 目标高度 | `h=600` |
| `fit` | - | 填充模式: cover/contain/fill/inside/outside | `fit=contain` |
| `crop` | - | 裁剪位置 | `crop=center` |
| `format` / `f` | `f` | 输出格式（大小写不敏感，jpg=jpeg，共享缓存） | `f=webp` |
| `quality` / `q` | `q` | 图片质量 1-100 | `q=85` |
| `watermark` / `wm` | `wm` | 启用水印 | `watermark=1` |
| `wmText` | - | 水印文字（支持中文、emoji、特殊字符） | `wmText=你好&copy;` |
| `wmSize` | - | 水印字号 | `wmSize=36` |
| `wmOpacity` | - | 水印透明度 0-1 | `wmOpacity=0.7` |
| `wmPosition` | - | 水印位置: north/northeast/.../center | `wmPosition=southeast` |
| `thumb` / `thumbnail` | `thumb` | 缩略图模式（默认 200×200） | `thumb=1` |
| `rotate` | - | 旋转角度 | `rotate=90` |
| `flip` | - | 水平翻转 | `flip=1` |
| `flop` | - | 垂直翻转 | `flop=1` |
| `blur` | - | 模糊程度 0.3-1000 | `blur=2` |
| `sharpen` | - | 锐化程度 | `sharpen=1` |
| `grayscale` / `bw` | `bw` | 灰度化 | `bw=1` |
| `sign` | - | URL 签名（签名启用时必填） | `sign=xxx` |
| `expires` | - | 过期时间（Unix 时间戳秒） | `expires=1781636344` |

---

## 核心架构设计

### 1. 动态处理缓存机制 — 两级缓存 + 单飞

两级缓存架构：
1. **内存 LRU 缓存**：最快命中，最多 500 项，按字节数限制容量
2. **磁盘文件缓存**：持久化，TTL 7 天，按 hash 前 2 位分目录

查询顺序：内存 → 磁盘 → 实际处理

**单飞机制（Single-Flight）**：并发请求同一未缓存结果时，仅首个请求执行处理，其余共享同一 Promise。统计项 `singleFlightSaved` 记录节省次数。

**响应头**：
- `X-Cache-Hit`: `true` / `false`
- `X-Cache-Source`: `memory` / `disk` / `processed`

关键代码：[cache.js - getOrProcess](file:///d:/trae-bz/TraeProjects/20006/src/cache.js#L281-L318)

---

### 2. 缓存 Key 设计 — 涵盖所有处理参数

**公式**：`SHA256(imageId | fileETag | sorted(normalizedParams))`

| 组成部分 | 作用 |
|---|---|
| `imageId` | 唯一标识原图 |
| `fileETag` | `size(36进制) + mtimeMs(36进制)`，原图变化自动失效 |
| `sorted(normalizedParams)` | 规范化后按键排序，消除顺序、大小写、格式别名差异 |
| `SHA256` | 256 位哈希，碰撞概率极低 |

**参数规范化**（确保等价格式共享缓存）：
- 格式：`WEBP` → `webp`，`jpg` → `jpeg`
- 别名合并：`w` / `width` → 统一为 `w`
- 布尔值：`watermark=1` 统一存储

磁盘存储：`cache/{hash前2位}/{hash}.{ext}`，避免单目录文件过多。

关键代码：[cacheKey.js - normalizeParams](file:///d:/trae-bz/TraeProjects/20006/src/cacheKey.js#L29-L54)

---

### 3. 原图删除/更新时派生缓存失效

**反向索引 + 文件 ETag 双重保险**：

**主动失效**（删除/更新时）：
- 维护 `imageId → Set<cacheKeyHash>` 反向索引
- 删除时批量清理内存 LRU + 磁盘文件

**被动失效**（缓存 Key 包含 fileETag）：
- 原图内容变化后，ETag 改变
- 旧缓存 Key 自动不再命中

**持久化索引**：索引存在 `cache/_index.json`，服务重启后自动加载；若索引损坏则从磁盘文件重建。

关键代码：
- [cache.js - invalidateByImageId](file:///d:/trae-bz/TraeProjects/20006/src/cache.js#L320-L354)
- [cache.js - 索引持久化](file:///d:/trae-bz/TraeProjects/20006/src/cache.js#L53-L155)

---

### 4. 超大图片内存限制 — 防止巨图撑爆

Sharp 流式处理 + 像素数硬限制：

```javascript
sharp(originalFilePath, {
  limitInputPixels: 268402689,  // 约 16383×16383
  failOn: 'none'
})
```

超出限制返回 413。其他防护措施：
- `withoutEnlargement: true` — 禁止放大
- LRU 缓存按 `buffer.length` 计算占用
- 上传时 50MB 文件大小限制
- 输出尺寸最大 8192×8192

---

### 5. 单飞机制（Single-Flight）

并发请求同一未缓存结果时，仅首个请求执行处理，其余共享同一 Promise：

```javascript
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

关键代码：[cache.js - getOrProcess](file:///d:/trae-bz/TraeProjects/20006/src/cache.js#L281-L318)

---

### 6. 签名 URL — 防滥用

启用签名后，动态处理接口必须携带有效签名，否则直接拒绝。

**启用方式**：设置环境变量 `SIGN_ENABLED=true` 和 `SIGN_SECRET=your-secret`

**签名算法**：
1. 收集所有查询参数（除 `sign` 外），按 key 排序
2. 拼接为 `/process/:id?key1=value1&key2=value2` 形式
3. 拼接密钥：`签名字符串 + secret`
4. SHA256 哈希即为签名

**过期时间**：`expires` 参数（Unix 时间戳，秒），过期后 URL 失效。

**服务端生成签名 URL**：
```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{"imageId":"abc123","params":{"w":"800","f":"webp"},"expiresIn":3600}' \
  http://localhost:3000/sign-url
```

关键代码：
- [signUrl.js - verifySignMiddleware](file:///d:/trae-bz/TraeProjects/20006/src/signUrl.js#L67-L97)
- [signUrl.js - generateSignedUrl](file:///d:/trae-bz/TraeProjects/20006/src/signUrl.js#L34-L54)

---

### 7. CDN 友好响应 — ETag + Last-Modified + 304

图片响应头包含：
- `ETag`: `"${cacheKeyHash}"`（同一张派生图永远一致）
- `Last-Modified`: 缓存文件创建时间
- `Cache-Control`: `public, max-age=31536000, immutable`（缓存命中时）

**条件请求**：客户端带 `If-None-Match` 或 `If-Modified-Since` 时，若内容未变返回 **304 Not Modified**，节省带宽。

同一张派生图无论从内存缓存还是磁盘缓存出来，ETag 和 Last-Modified 都保持一致。

关键代码：[routes/process.js - checkConditionalRequest](file:///d:/trae-bz/TraeProjects/20006/src/routes/process.js#L30-L56)

---

### 8. 水印安全 — 特殊字符兼容

水印文字经过完整 **XML 实体转义**，支持：
- 特殊字符：`&` → `&amp;`，`<` → `&lt;`，`>` → `&gt;`，`"` → `&quot;`，`'` → `&apos;`
- 中文、日文等多字节字符
- Emoji 表情

SVG 画布尺寸根据文字内容动态计算（中文按全角宽度估算），避免文字被截断。

关键代码：[processor.js - escapeXml](file:///d:/trae-bz/TraeProjects/20006/src/processor.js#L228-L236)

---

### 9. 缓存管理面板 — 运维友好

#### 缓存统计

```
GET /cache/admin/stats
```

返回内容：
- **memory**：内存缓存项数、字节数、MB
- **disk**：磁盘缓存项数、总字节数、图片数、按格式分布
- **stats**：命中数、未命中、处理数、单飞节省数、命中率
- **ranking**：派生图数量 Top 20 的图片排行榜
- **uptime**：运行时间、启动时间
- **inFlight**：进行中的处理请求数

#### 缓存清理策略

```bash
# 全部清理
curl -X POST -H "Content-Type: application/json" \
  -d '{"scope":"all"}' \
  http://localhost:3000/cache/admin/clear

# 只清内存
curl -X POST -H "Content-Type: application/json" \
  -d '{"scope":"memory"}' \
  http://localhost:3000/cache/admin/clear

# 按格式清理（所有 webp）
curl -X POST -H "Content-Type: application/json" \
  -d '{"format":"webp"}' \
  http://localhost:3000/cache/admin/clear

# 按时间范围清理（7天前）
curl -X POST -H "Content-Type: application/json" \
  -d '{"olderThan":604800}' \
  http://localhost:3000/cache/admin/clear

# 按时间戳范围清理
curl -X POST -H "Content-Type: application/json" \
  -d '{"from":1781000000,"to":1781600000}' \
  http://localhost:3000/cache/admin/clear

# 按图片 ID 清理
curl -X POST -H "Content-Type: application/json" \
  -d '{"imageId":"abc123"}' \
  http://localhost:3000/cache/admin/clear
```

#### 单图缓存详情

```
GET /cache/admin/image/:id
```

返回该图所有派生缓存的格式、大小、创建时间、最后访问时间。

#### 派生图排行榜

```
GET /cache/admin/images/ranking
```

按派生图数量排序的 Top 20 图片列表，方便找到热点图。

关键代码：
- [routes/cacheAdmin.js](file:///d:/trae-bz/TraeProjects/20006/src/routes/cacheAdmin.js)
- [cache.js - getStats](file:///d:/trae-bz/TraeProjects/20006/src/cache.js#L433-L500)

---

### 10. 索引持久化 & 服务重启恢复

**存储**：`cache/_index.json`，包含所有缓存的元数据和 imageId 反向索引。

**启动时加载**：
1. 优先加载 `_index.json`，快速恢复索引
2. 若索引损坏或缺失，遍历磁盘文件重建索引
3. 每 30 秒自动保存一次（有变更时）
4. 清理操作后立即保存

确保服务重启后，仍能按 imageId 查找和清理历史派生缓存。

---

## 目录结构

```
src/
├── app.js                  # Express 应用入口 + 错误处理
├── config.js               # 全局配置
├── cacheKey.js             # 缓存 Key 生成（SHA256 + 参数规范化）
├── cache.js                # 缓存层（内存 LRU + 磁盘 + 单飞 + 索引持久化）
├── processor.js            # 图片处理核心（sharp 封装 + 预设 + 水印）
├── signUrl.js              # 签名 URL 生成与验证
└── routes/
    ├── images.js           # 图片上传 / CRUD
    ├── process.js          # 动态处理接口（带 CDN 头 + 签名校验）
    └── cacheAdmin.js       # 缓存管理接口
uploads/                    # 原图存储
cache/                      # 处理结果磁盘缓存 + _index.json
```

---

## 配置项

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `PORT` | 3000 | 服务端口 |
| `SIGN_ENABLED` | `false` | 是否启用签名验证 |
| `SIGN_SECRET` | `image-service-default-secret-key` | 签名密钥 |

更多配置见 [config.js](file:///d:/trae-bz/TraeProjects/20006/src/config.js)。

---

## 使用示例

```bash
# 1. 上传图片
curl -X POST -F "image=@photo.jpg" http://localhost:3000/images/upload

# 2. 使用预设快速处理
curl "http://localhost:3000/process/xxx?preset=avatar"
# 响应头 X-Preset: avatar
# 响应头 ETag: "xxxxx"

# 3. 自定义参数 + WebP 格式
curl "http://localhost:3000/process/xxx?w=800&h=600&f=WEBP&q=80"
# f=WEBP 和 f=webp 命中同一份缓存

# 4. 快速获取缩略图
curl "http://localhost:3000/process/xxx/thumbnail"

# 5. 查看缓存统计
curl http://localhost:3000/cache/admin/stats

# 6. 清理所有 WebP 格式缓存
curl -X POST -H "Content-Type: application/json" \
  -d '{"format":"webp"}' \
  http://localhost:3000/cache/admin/clear

# 7. 生成签名 URL
curl -X POST -H "Content-Type: application/json" \
  -d '{"imageId":"xxx","params":{"preset":"medium"},"expiresIn":86400}' \
  http://localhost:3000/sign-url

# 8. 删除图片（自动清理所有派生缓存）
curl -X DELETE http://localhost:3000/images/xxx
```
