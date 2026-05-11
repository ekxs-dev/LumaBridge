# LumaBridge 当前阶段状态

更新日期：2026-05-11

## 阶段结论

这一阶段已经把网页端 DV P5 诊断管线搭起来了，也把“快速预览”和“正确 DV P5 转 SDR”之间的边界确认清楚了。

当前浏览器实现已经可以：

- 解析 MP4，并对大型 Matroska 文件做 prefix 解析。
- 识别 HEVC codec string 和 Dolby Vision RPU NAL。
- 探测 WebCodecs 支持情况，并明确区分 raw access 能力。
- 通过 `ffmpeg.wasm` fallback 解出 raw `I420P10` 帧。
- 通过 Rust/WASM 解析选中帧的 RPU metadata。
- 把 raw Y/U/V plane 上传到 WebGPU buffer。
- 用 WGSL 渲染 SDR 诊断预览。
- 手动加载 libplacebo PNG 参考图，并和当前 raw WebGPU 预览做像素误差比较。
- 用短 raw chunk 做低帧率 realtime-ish fallback 预览。
- 用 WebCodecs/WebGPU opaque path 做快速可见性和速度诊断。

但当前还不是完整、参考级对齐的 DV P5 到 SDR 转换器。

## 关键判断

Chrome 对当前测试的 HEVC/DV P5 文件可以走 WebCodecs 解码，但输出是 opaque frame：

```text
VideoFrame.format === null
VideoFrame.copyTo() raw I420P10 不可用
```

这意味着快速浏览器路径可以很快显示画面，但不能用于正确的 DV P5 到 SDR。

目前唯一能在网页端拿到 raw 10-bit frame 的路径是：

```text
ffmpeg.wasm
  -> raw yuv420p10le / I420P10
  -> Rust/WASM RPU metadata
  -> WebGPU WGSL 诊断渲染
```

这条路径适合做正确性验证、单帧检查、低帧率跟踪和 libplacebo 对齐工作，但不适合 4K 24/30/60fps 实时播放。

## 本阶段删除的内容

已经删除旧的 `external recovery` selector。

它之前尝试过这些组合：

```text
BT.709 / BT.2020
full / limited range
UV swap
U/V/UV flip
```

8.5 秒手动诊断已经证明：这些组合不能从 Chrome opaque RGB frame 里恢复正确的 DV P5 base signal。继续保留会让 UI 看起来像 opaque path 还能被调成正确路径，这是误导。

现在保留的 external texture 路径只叫 fast opaque preview。它只用于速度和可见性，不用于颜色正确性。

## 当前预览路径

### 1. 正确性优先路径

```text
ffmpeg.wasm raw I420P10
  -> RPU metadata parse
  -> WebGPU buffer upload
  -> WGSL diagnostic SDR render
```

用途：

- 查看指定时间点。
- 检查 raw luma 和 DV P5 base 行为。
- 对比 libplacebo reference PNG。
- 继续做 WGSL/libplacebo 对齐。

限制：

- 4K 下无法达到正常视频帧率。
- 还没有完全对齐 libplacebo color map / gamut 行为。
- 大型 Matroska 当前仍然是 prefix 解析，完整流式 demux 尚未完成。

### 2. Fast WebCodecs Canvas Preview

```text
WebCodecs opaque VideoFrame
  -> canvas drawImage()
```

用途：

- 检查浏览器解码速度。
- 检查从指定时间点开始播放的行为。
- 快速确认画面是否可见。

限制：

- 输入已经是浏览器转换后的 opaque RGB。
- 不能用于参考颜色对比。

### 3. Fast WebGPU Opaque Preview

```text
WebCodecs opaque VideoFrame
  -> GPUExternalTexture
  -> simple WebGPU shader
```

用途：

- 快速验证 WebGPU external texture 渲染。
- 检查 UI、播放节奏和逐帧调度。

限制：

- 同样从浏览器转换后的 opaque RGB 开始。
- 不是 DV P5 SDR 正确路径。
- 不提供 reference compare。

## 性能现状

大型本地 DV P5 Matroska 样本上的观察结果：

```text
3840 x 1608
ffmpeg.wasm core-mt 可用
target 4 fps
实际约 2 fps
一次观察中 5-frame chunk decode 约 162 ms
一次观察中平均 frame time 约 413 ms
```

这说明短 segment decode 已经明显好于 seek-per-frame，但距离 4K 24/30/60fps 仍然很远。

如果要做到正常视频帧率并保持正确 DV P5 SDR，仍然需要以下路线之一：

- 浏览器 WebCodecs 未来稳定暴露真实 `I420P10` frame，并允许 `copyTo()`。
- native helper 解码 HEVC Main10，再把 raw frame 传给网页。
- 服务端解码和色彩处理。
- 一个比当前 ffmpeg.wasm 快很多的浏览器内解码路径。

## 当前正确性差距

RPU 解析和 compact metadata packing 已经有较好的测试覆盖。现在最大的已知差距在 DV decode 之后的色彩映射：

```text
libplacebo:
reshape
  -> nonlinear matrix/offset
  -> PQ EOTF
  -> HPE LMS / BT.2020 matrix path
  -> PQ OETF
  -> full color_map / gamut mapping

current WGSL:
reshape diagnostics
  -> simplified BT.2390/IPT-style SDR mapping
  -> RGB softclip
```

下一阶段如果继续做正确性，重点应该放在 libplacebo 风格的 post-DV color map 和 gamut behavior。

## 人工测试方式

启动：

```bash
npm run dev
```

打开：

```text
http://127.0.0.1:5173/bench
```

建议检查：

- 选择 `/path/to/input.mkv`。
- 确认 fallback 显示 `ffmpeg.wasm`，并且有 `multi-thread, threaded, isolated`。
- 用 selected timestamp 渲染 raw `I420P10` WebGPU 诊断帧。
- fast opaque preview 只用于速度和可见性，不用于判断颜色正确性。
- 只有 raw WebGPU SDR preview 才适合加载 libplacebo PNG 做 reference compare。

## 验证命令

```bash
npm run test
npm run build
npm run test:e2e
npm run test:rust
```

本阶段收口前，上面四个命令都应通过。

