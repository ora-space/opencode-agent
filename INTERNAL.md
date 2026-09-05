# 内部特供版

一个短期使用的变体：构建时读取被 git 忽略的 `config.toml`，把 provider（及其
packed API key）预置进包里，CLI 无需登录即可使用。构建注入由
[`scripts/inject-provider-config.ts`](scripts/inject-provider-config.ts)
完成，运行时由 [`src/services/provider-env.ts`](src/services/provider-env.ts)
解码并生成环境变量。

> 本文件**不会**被打进 `.orax`（包里只有
> `README.md`、`logo.svg`、`main.js`、manifest 和 CLI）。请保持这样——如果把 key
> 的处理机制写进随包分发的 README，就等于把破解说明一起发给用户，混淆 key
> 的意义也就没了。

## 原理

`providerEnv()` 返回一个 `OPENCODE_CONFIG_CONTENT` 环境变量，内联定义一个已填好
API key 的 provider。OpenCode 会以最高优先级 merge 这份配置，并直接读取
`provider.<id>.options.apiKey`——无需 `auth.json`、无需登录。key
以**打包（packed）**形式存放（先与字节掩码做 XOR，再 base64），因此在发布的
bundle 里不是一个明文字符串。

这个打包**不是加密**。任何拿到包的人只要读 `unpack` 和掩码就能还原出
key，它只能防止 key 以明文被 grep 到，仅此而已。如果要求 key
不可还原，那它就不能出现在客户端里——只能让请求经过你自己控制的服务端中转。

## 配置 provider

复制 `config.toml.template` 为 `config.toml`，然后填写 `[provider]`：

```toml
[provider]
id = "my-provider"
name = "My Provider"
base_url = "https://example.com/v1"
model_id = "my-model"
model_name = "My Model"
encoded_api_key = "..."
mask = [0x3b, 0x9a, 0x54, 0xd1]
```

- `baseURL` 必须是 **OpenAI 兼容**端点（带上 `/v1` 之类后缀）。如果不是直连
  DeepSeek，改成你自己的网关地址。
- `modelId` 会原样作为请求的 `model` 字段发出。provider 无论如何都能加载，但 id
  写错只有在**真正发消息**时才会报错。（DeepSeek 官方的 id 是 `deepseek-chat` 和
  `deepseek-reasoner`。）
- 当前注入器从配置生成一个模型，并在 provider 和 model 两层设置
  `body.stream = true`。

## 烘入 key

**不要**把明文 key 写进仓库。`config.toml` 只保存 `encoded_api_key` 和对应的
`mask`；构建时两者进入 bundle，运行时才解码。轮换 key 时同时更新这两个字段。

> **不要**把填了真实 key 的 `PACKED` 提交到共享仓库——它会永久留在 git
> 历史里。只在打包那一刻烘进去，提交前清空。

## 构建与打包

```sh
deno task build                                            # 打包 src → dist/main.js（key 已烘入）
deno task package --tag <tag> --repo <owner/name>          # 生成全部目标的 .orax
deno task package --tag <tag> --repo <owner/name> --target x86_64-pc-windows-msvc
```

- `package` 默认打包 `bundle.config.ts` 里的全部平台；传 `--target`
  时只打指定平台。
- `--tag`/`--repo` 只影响 release manifest 里的下载
  URL。本地导入测试时随便填合法值即可——你导入的 `.orax` 文件本身不依赖它们。
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

删除 [`src/services/provider-env.ts`](src/services/provider-env.ts)，并从
[`src/services/command.ts`](src/services/command.ts) 中移除它的 `import`
以及那行
`invocation = { ...invocation, env: { ...providerEnv(), ...invocation.env } }`。即可恢复为普通版插件。
