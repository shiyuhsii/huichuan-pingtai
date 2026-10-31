# 回传平台

用于零件图像归档、候选区域复核和报告导出的单机工作台。支持手动导入图片，也可以通过配套串口接收桥导入 FPGA 的 CNN 检测截图。

每位使用者在自己的电脑运行，图片与复核记录保存在各自电脑。没有 FPGA 板子、没有 AI 密钥也可以使用图片导入和人工复核功能。

## 快速开始

需要 **Node.js 22.15 或更新版本**，建议使用 Node.js 22 LTS，并确保安装时包含 npm。首次安装需要联网下载依赖。

### Windows

1. 在本仓库点击 **Code → Download ZIP**，解压到一个普通文件夹。
2. 双击根目录的 **`start-platform.cmd`**。
3. 首次启动会安装依赖并初始化本地数据库；看到服务地址后，在浏览器打开：

   `http://127.0.0.1:5317/signin-with-chatgpt?return_to=/`

这个地址使用项目自带的本地模拟登录，无需 ChatGPT 账号。保持启动窗口开启；关闭窗口即可停止平台。以后继续双击同一个文件即可，数据会保留。

### 终端启动 / macOS / Linux

在解压后的仓库目录执行：

```sh
cd sites/inspection-platform
npm ci
npm run setup:local
npm run serve
```

然后打开上面的地址。使用其他端口时执行 `npm run serve -- --port 5417`，并相应替换浏览器地址。按 `Ctrl+C` 结束服务。完整启动流程已在 Windows 验证，其他系统可使用这些终端命令，尚未逐一实机验证。

## 能做什么

- 导入 JPG、PNG、WebP，按零件编号与批次归档。
- 手动画框、点击局部放大，确认划痕、标记孔洞/连接处/阴影或移除误检框。
- 保存区域标签、备注及整条记录的人工结论。
- 查看拍摄亮暗和清晰度参考提示。
- 搜索记录、按批次筛选、查看待复核与已复核数量。
- 导出标注图、记录 JSON；生成中文报告并通过浏览器打印为 PDF。
- 可选通义千问视觉辅助分析；未配置密钥时正常使用人工复核，不生成虚构 AI 结果。
- 可选 FPGA 串口回传与自动打开最新检测记录。

拍摄质量指标和 AI 建议用于辅助复核，不是经过工业认证的合格判定。导入图像不等于运行 FPGA/CNN 推理；平台本身不包含板端固件或模型训练流程。

## 可选：FPGA 自动回传

该接收桥兼容 **B3260012 / VFAUTO1 R2** 回传协议。板端程序、下载器驱动及硬件需自行准备；不需要使用这个功能时，可以跳过本节。

安装 Python 3.10 或更新版本，然后在仓库根目录执行：

```sh
python -m pip install -r cnn_pc_site/requirements.txt
python cnn_pc_site/receiver_site.py --site-url http://127.0.0.1:5317
```

存在多个 CH340 串口时，增加 `--port COM13`（替换为自己的串口）。可通过 `--output "保存目录"` 指定归档位置。

操作：启动平台和接收桥 → 板子进入 CNN 模式 → 确认 HDMI 显示 `PC: READY` → 重新冻结至少有一处候选区域的画面 → 保持冻结直到保存完成。

这个协议实际回传带灰度、边缘视图和标记的检测截图，没有单独的无框原图或结构化框坐标。桥接程序从截图中恢复完整红色矩形，供网页点击复核；原始截图保留。它不会补传接收器就绪之前已经完成的检测，也不会传送零候选区域的结果。显示串口打开不代表已经收到有效检测帧。

默认归档到当前用户桌面的 `FPGA检测记录/日期/时间_CNN_会话_编号/`。网站导入失败会独立重试，不影响已校验截图的本机保存。协议与操作细节见 [接收桥说明](cnn_pc_site/README.txt)。

## 可选：AI 辅助分析

在 `sites/inspection-platform` 中复制 `.dev.vars.example` 为 `.dev.vars`，填入自己的 `DASHSCOPE_API_KEY`，然后重新启动平台。可选 `AI_MODEL`，默认 `qwen3-vl-plus`。

只有点击 AI 分析时，所选图片才发送到配置的通义千问服务，可能产生 API 费用。密钥仅放在本机 `.dev.vars`，不要提交到 GitHub。AI 建议不会覆盖人工结论；没有密钥时无需配置任何内容。

## 数据与备份

- 图片、记录和复核状态：`sites/inspection-platform/.wrangler/state/`。
- 可选接收桥日志与同步状态：`cnn_pc_site/.runtime/`。
- 备份时先停止平台，再复制整个 `.wrangler/state`；如使用串口回传，也备份桌面的归档目录。
- 不要用全新解压目录覆盖旧数据目录；更新源码前先备份。

公开仓库不包含作者的检测照片、数据库、日志、API 密钥、Site 身份或 FPGA 固件。启动页使用中性占位图，测试图片为合成夹具。

## 开发与检查

```sh
cd sites/inspection-platform
npm run typecheck
npm test
npm run build
```

接收桥离线测试（不会打开真实串口）：

```sh
cd cnn_pc_site
python -m unittest -v test_receiver_site test_display_boxes
```

接口检查需要先启动一个独立的测试平台，设置 `INSPECTION_TEST_URL` 后运行 `node tests/integration.mjs`。它会创建并删除一条合成测试记录，不应对正在工作的真实记录库运行。

本项目使用 React、Vinext、Cloudflare 本地 D1/R2 模拟存储。普通使用不需要安装 Codex、Sites 插件或云服务账号。GitHub 托管源码；当前发行版是单机应用，不是 GitHub Pages 静态网站，也没有面向公网的多人登录系统。

## 许可证

项目源码采用 [MIT License](LICENSE)。已打包的第三方组件保留各自许可，见 [第三方说明](THIRD_PARTY_NOTICES.md)。
