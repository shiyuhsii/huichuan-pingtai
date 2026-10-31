# 回传平台：网页与本机服务

完整安装、运行、FPGA 接收和备份说明见 [仓库首页](../../README.md)。

```sh
npm ci
npm run setup:local
npm run serve
```

打开 `http://127.0.0.1:5317/signin-with-chatgpt?return_to=/`。数据库与图片保存在本目录 `.wrangler/state`。

可选 AI 配置使用 `.dev.vars.example`；普通复核无需密钥。请勿提交自己的 `.dev.vars`、数据库或图片记录。
