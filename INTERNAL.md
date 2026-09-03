# 内部特供版

一个短期使用的变体：把某个 provider（及其 API key）预置进包里，CLI 无需登录即可使用。特供版的全部逻辑集中在**一个文件** [`src/services/provider-env.ts`](src/services/provider-env.ts) 里，另外只在 [`src/services/command.ts`](src/services/command.ts) 加了一行，把它的环境变量合并进每次 OpenCode 启动。

> 本文件**不会**被打进 `.orax`（包里只有 `README.md`、`logo.svg`、`main.js`、manifest 和 CLI）。请保持这样——如果把 key 的处理机制写进随包分发的 README，就等于把破解说明一起发给用户，混淆 key 的意义也就没了。

## 原理

`providerEnv()` 返回一个 `OPENCODE_CONFIG_CONTENT` 环境变量，内联定义一个已填好 API key 的 provider。OpenCode 会以最高优先级 merge 这份配置，并直接读取 `provider.<id>.options.apiKey`——无需 `auth.json`、无需登录。key 以**打包（packed）**形式存放（先与字节掩码做 XOR，再 base64），因此在发布的 bundle 里不是一个明文字符串。

这个打包**不是加密**。任何拿到包的人只要读 `unpack` 和掩码就能还原出 key，它只能防止 key 以明文被 grep 到，仅此而已。如果要求 key 不可还原，那它就不能出现在客户端里——只能让请求经过你自己控制的服务端中转。

## 配置 provider

编辑 [`src/services/provider-env.ts`](src/services/provider-env.ts) 里的 `PROVIDER` 对象：

```ts
const PROVIDER = {
  id: "ora-deepseek",              // provider id，在选择器里显示为 `<id>/<model>`
  name: "ORA Deepseek",            // 显示名称
  baseURL: "https://api.deepseek.com/v1",  // 网关的 OpenAI 兼容 base URL
  modelId: "deepseek-v4-flash",    // 必须与你网关请求体里接受的 model id 一致
  modelName: "DeepSeek V4 Flash",  // 模型的显示名称
};
```

- `baseURL` 必须是 **OpenAI 兼容**端点（带上 `/v1` 之类后缀）。如果不是直连 DeepSeek，改成你自己的网关地址。
- `modelId` 会原样作为请求的 `model` 字段发出。provider 无论如何都能加载，但 id 写错只有在**真正发消息**时才会报错。（DeepSeek 官方的 id 是 `deepseek-chat` 和 `deepseek-reasoner`。）
- 想加更多模型，在 `providerEnv()` 里的 `models` 下增加条目。

## 烘入 key

**不要**把明文 key 直接粘进文件。先打包——这个文件自身就是打包器：

```sh
deno run src/services/provider-env.ts "sk-你的真实key"
```

它会打印一串打包后的字符串。把它粘进同一个文件的 `PACKED`：

```ts
const PACKED = "……打印出来的字符串……";
```

`PACKED` 留空时 `providerEnv()` 是空操作，插件行为与普通版完全一致。

轮换 key：用新值重新跑一遍打包器，替换 `PACKED`。移除 key：把 `PACKED` 改回 `""`。

> **不要**把填了真实 key 的 `PACKED` 提交到共享仓库——它会永久留在 git 历史里。只在打包那一刻烘进去，提交前清空。

## 构建与打包

```sh
deno task build                                            # 打包 src → dist/main.js（key 已烘入）
deno task package --tag <tag> --repo <owner/name>          # 生成 dist/packages/*.orax
```

- `package` 会按 `bundle.config.ts` 里的每个平台，通过 `gh` 下载对应的 OpenCode CLI（需先登录 gh），每个平台产出一个 `.orax`。
- `--tag`/`--repo` 只影响 release manifest 里的下载 URL。本地导入测试时随便填合法值即可——你导入的 `.orax` 文件本身不依赖它们。
- 把对应平台的 `.orax` 手动导入 Ora 测试。

## 校验产物不含明文 key

```sh
# 从 .orax 里取出 main.js，检查注入是否存在、以及是否没有明文 key
python - <<'PY'
import zipfile
z = zipfile.ZipFile("dist/packages/<你的>.orax")
mj = z.read("main.js").decode("utf-8", "replace")
print("注入存在:", "OPENCODE_CONFIG_CONTENT" in mj and "ora-deepseek" in mj)
print("含明文 'sk-':", "sk-" in mj)   # 期望：False
PY
```

## 移除特供版

删除 [`src/services/provider-env.ts`](src/services/provider-env.ts)，并从 [`src/services/command.ts`](src/services/command.ts) 中移除它的 `import` 以及那行 `invocation = { ...invocation, env: { ...providerEnv(), ...invocation.env } }`。即可恢复为普通版插件。
