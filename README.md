# cjf · 一张照片的空间

一个无需构建、无需后端的三维人像展示网站。使用已有 cjf 单张照片的 ML-SHARP 输出，浏览器直接渲染 1,174,324 个三维高斯。

## 体验

- 拖动：自由环绕，水平方向可转一整圈；不会松手后回中。
- Shift + 拖动、右键拖动或“平移”：移动观察位置。
- 滚轮：拉近 / 拉远。手机支持单指环绕、双指缩放与平移。
- 原视角：恢复最初照片的相机位置。
- 自动环绕、全屏、链接分享；不支持 WebGL2 的浏览器可观看动态视频。
- 键盘：方向键环绕，+ / - 缩放，R 复位（先点选画面）。

这是单张照片推断的三维场景，背面并未被拍摄。大幅转动时会露出空洞、拉伸或缺失。网站允许自由探索，不能将其视为完整的人物扫描或真实测量数据。

## 本地查看

在此目录运行 `python serve.py`，打开 http://127.0.0.1:8771/ 。不要直接双击 HTML；浏览器需要通过 HTTP 读取场景文件与排序 worker。此脚本固定 JavaScript 的 MIME 类型，避免 Windows 注册表将 `.js` 映射成纯文本而导致模块不能运行。

`prepare_assets.py` 从已有输出复制展示图片和视频、gzip 无损压缩高斯数据，不重新运行模型。站点没有第三方 JavaScript、CDN、分析 SDK、Cookie 或上传接口；所有路径均为相对路径，可直接部署在 GitHub Pages 的项目子目录。

## GitHub Pages

将本目录的站点文件上传到一个专用仓库。仓库 Settings → Pages → Deploy from a branch，选择 `main` 的根目录 `/ (root)`。首页为 `index.html`，`.nojekyll` 禁用 Jekyll。

`publish_github.py --repo cjf-3d-gallery` 可使用 Git 已有的 GitHub 凭据创建一个新的公开仓库、推送并启用 Pages。它不会把 Token 写入文件或 remote，不覆盖未知的现有仓库，也不会强制推送。没有登录时将停在凭据检查。

部署方式依据 [GitHub 官方文档](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site)。上线后网址为 `https://<username>.github.io/<repository>/`；请以实际部署成功和 HTTP 访问验证为准。

## 渲染与来源

展示器是本项目独立编写的 WebGL2 高斯投影与透明度混合实现。协方差随相机旋转，worker 按当前相机方向将高斯从远到近排序。与官方 gsplat 的抗锯齿和颜色处理可能不同。纹理使用 Float32，传输数据使用 gzip，无损保留已有高斯数据。

模型生成工具：[Apple ML-SHARP](https://github.com/apple-aiml-research/ml-sharp)，本地生成工具源码提交 `aed6527499ef91cba3b54c18d49a870f25947190`。网站没有包含推理权重或推理服务。许可证与致谢保存在 `licenses/`，生成模型的研究用途限制以许可原文为准。本网站作为非商业三维重建实验的结果展示。

Apple Machine Learning Research Model is licensed under the Apple Machine Learning Research Model License Agreement.

人像照片和高斯输出的权利归各自权利人；本仓库不授予他人人像或照片的再使用许可。
