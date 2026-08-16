# dsh-msg-index

>长对话的时候经常忘了自己下了什么命令，dsh对话太长翻起来很麻烦，因此搓了这个项目。在代码能跑的基础上添加了没什么用的模糊。

注意⚠️：代码几乎完全由deepseek完成，目前这个版本在本人harness中暂时良好运行，但是不保证不会出现任何bug，本人非计算机专业，此项目发出来主要是存档自用，同时希望能方便到和我有同样需求的用户，欢迎各位大佬修改完善、批评指正 


DeepSeek Harness 的对话窗口消息索引插件：一个悬浮在对话窗口的**类磨砂玻璃圆球**，点击展开**当前会话的用户消息索引**，点击任意条目即可**平滑定位**到对应消息。

![效果演示](assets/demo.png)

## 功能

- **消息索引**：展开后列出当前会话的用户消息（编号 + 内容预览），不主动加载全部历史。
- **点击定位**：点击索引条目平滑滚动到对应消息。
- **搜索**：标题栏 🔍 按钮弹出搜索框，支持按**消息编号**（数字）或**消息内容**（不区分大小写）搜索，**实时预览**匹配结果并**高亮命中片段**，保留原始编号。

## 关于"更早的消息"

DSH 的对话页面只渲染视口附近的少量消息（虚拟窗口），更早的消息虽然在数据里、但不在页面上。本插件**不会在打开面板时一次性加载全部历史**（避免所有对话被一次性渲染导致卡顿），而是：

- **只展示当前已加载的部分**，并在头部显示"更早未加载"标记；
- **未加载的**：点击列表顶部的"加载更早消息"按钮逐页加载；
- **已加载但未渲染到页面**（虚线框分组）：点击会**自动加载并定位**（先加载数据，再滚动触发渲染，稍慢几秒）；这是 Harness 的渲染窗口限制，插件只能尽量绕开。

## 安装

```sh
# 始终安装最新版（推荐）：
dsh plugin --profile web add -w https://github.com/stnt04/dsh-msg-index/releases/latest/download/dsh-msg-index.tgz

# 或指定版本安装：
dsh plugin --profile web add -w https://github.com/stnt04/dsh-msg-index/releases/download/v1.0.0/dsh-msg-index.tgz
```

安装后重启 `dsh web`，在对话窗口右下角即可看到悬浮圆球。

> 升级插件：重新执行上面的命令（latest 链接会自动拿到最新版），然后刷新浏览器页面即可生效。若重新执行后版本未更新（pnpm 可能缓存了同一 URL），改用指定版本的链接，或执行 `dsh plugin --profile web update dsh-msg-index`。若涉及服务端或配置变更需重启 `dsh web`。

## 发布

打一个 `v*` 标签推送到 GitHub 即可触发 Actions 自动构建并发布 Release（附件为固定文件名 `dsh-msg-index.tgz`，latest 链接自动指向最新版）：

```sh
git tag v1.0.0
git push origin v1.0.0
```

## 构建

```sh
pnpm install   # 需要 pnpm 11+（lockfile 由 pnpm 11 生成）
pnpm build     # tsc 编译服务端(lib/) + tsdown 打包 client(client/client.js)
npm pack       # 生成发布用 dsh-msg-index-<version>.tgz（可选，本地验证用）
```

产物：`client/client.js`（`__ModuleLoader__` 格式）、`lib/index.js`。

## 工作原理

- 通过 `shell.overlay` 插槽注入宿主组件，再用 `SessionProvider` 桥接一个 **session 作用域子插槽**（`dsh-msg-index.rail`），组件直接拿到当前 `sessionId` 与 `useSession` 订阅器。
- 会话数据来自 **`sessions` 服务**：`session.getSnapshot()` 读取 `chat.order` / `chat.nodes`，`session.loadOlder()` 拉取更早历史，直到 `hasMore` 为 false。
- 用户消息 = 节点 `kind === "user"` 的条目，文本从 `data.content` 提取。
- 页面定位用运行时自带的 **`data-chat-anchor-key` 属性**（值即节点 key）精确匹配行元素，未渲染的行按其在消息顺序中的比例粗滚滚动容器后再轮询定位。

## 已知问题

> ⚠️ **点击"加载更早"多次或定位很远的早期消息时，加载较多消息可能导致网页渲染变慢，但事实上输入输出速度并未受到影响**

## 注意事项

- 页面行定位依赖 DSH 运行时提供的 `data-chat-anchor-key` 属性与主滚动容器的 `_scrollBody` 类后缀；若 DSH 版本更新导致这些选择器失效，需同步调整。
- 纯自用/留档项目：代码以满足"能跑"为标准。

## License

MIT
