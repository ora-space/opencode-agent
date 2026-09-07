# OpenCode v2 配置字段被 v1 CLI 静默忽略

## 执行摘要

内部版插件生成并成功打包了 `providers/package/settings` 形式的 provider
配置，但随包运行的 OpenCode `v1.18.x` 只读取 `provider/npm/options`，因此
provider 和模型没有生效。OpenCode
对未知顶层字段返回成功且不输出错误，现有检查又只证明代码能编译、bundle
含有目标字符串，没有验证字段属于实际 CLI
的配置版本。持久结论是：配置兼容性必须在最终构建产物上按目标版本检查，不能由
JSON 可生成或关键词存在来代替。

## 摘要

问题发生在 `ai-coding-lab.opencode` 内部版的 provider 注入流程。构建脚本从
`config.toml` 生成 `OPENCODE_CONFIG_CONTENT`，最初参考 OpenCode v2 文档生成
`providers/package/settings/body`，而当时 `.orax` 捆绑的是 OpenCode
`v1.18.27`。构建、lint
和类型检查均成功，插件也能启动，但用户看到的唯一症状是“没生效”。不存在可搜索的运行时错误字符串；直接探测得到的是
`plural: exit=0 accepted=False`，即 CLI 以退出码 0 忽略了配置。

## 影响

受影响的是使用该内部包预置 provider 的用户。插件和 OpenCode ACP
进程能够正常启动，但预置 provider、模型、API 地址及 `body.stream`
均未进入有效配置，用户无法按预期选择或调用该模型。没有发现数据损坏或请求发往错误服务；影响止于配置未加载和重复打包、安装、排查。

## 时间线

- 为给 OpenAI-compatible provider 增加 `body.stream = true`，实现采用了文档中的
  `providers/package/settings` 结构，并在 provider 与 model 两层写入 `body`。
- `deno task check`、`deno task lint`、`deno task build` 全部通过；随后仅在
  `dist/main.js` 中搜索 `providers`、`openai-compatible` 和
  `stream`，这些检查证明字符串被写入，却没有证明 OpenCode 接受它们。
- 生成的 OpenCode `v1.18.27` `.orax` 被实际使用后，用户报告配置“没生效”。由于
  CLI 没有错误输出，调查最初仍集中在注入链路和 stream 字段位置。
- 使用真实的 OpenCode `debug config --pure` 分别输入两种最小配置后，得到
  `plural: exit=0 accepted=False` 和
  `singular: exit=0 accepted=True`，确认版本错配。
- 注入结构改为 `provider/npm/options/models`，默认模型改为
  `<provider>/<model>`，provider 与 model 的 stream 配置分别放入两层
  `options.body`。真实 CLI 随后解析到 provider、model 和两个 stream 值。
- 修复随 commit
  `3758851`（`feat: inject provider config during packaging`）推送到
  `internal-edition`；没有关联 PR、RFC 或 issue。

## 根因 #1 — 未绑定版本的配置文档被用于生成 OpenCode v1 配置

插件下载并捆绑 OpenCode v1 CLI，但实现时采用了 OpenCode v2 provider
文档的字段。两套格式都是合法 JSON，字段语义也高度相似；OpenCode v1
的解析器允许未知顶层字段存在并以成功状态退出，因此错配没有在配置加载边界暴露。

```jsonc
// 错误：OpenCode v2 字段，v1 CLI 静默忽略 providers
{
  "providers": {
    "acme": {
      "package": "@opencode-ai/ai/providers/openai-compatible",
      "settings": { "baseURL": "https://example.com/v1" },
      "body": { "stream": true }
    }
  }
}

// 修复：OpenCode v1.18.x 实际读取的字段
{
  "provider": {
    "acme": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://example.com/v1",
        "body": { "stream": true }
      },
      "models": {
        "coding": {
          "options": { "body": { "stream": true } }
        }
      }
    }
  }
}
```

## 为什么所有检查都漏掉了

对于“最终 bundle 包含属于另一个 OpenCode
配置版本的字段”这一情况，构建产物上的版本字段校验从未执行。

- 测试缺口：仓库没有 provider 配置版本测试；`tests/host-simulator.ts`
  运行源码入口，构建时注入只发生在 `dist/main.js`，所以它不覆盖该路径。
- 工具缺口：`deno check` 检查 TypeScript 类型，provider 配置由普通对象和 JSON
  字符串承载，类型系统无法区分 OpenCode v1 与 v2 字段。
- 构建缺口：`deno task build` 只完成 bundle、文本替换和标识符混淆；只要 JSON
  可序列化就成功。
- 断言缺口：产物核验搜索的是实现自己的输出字符串。错误配置同样稳定包含
  `providers` 和 `stream`，所以这种自我报告无法证明外部 CLI 接受配置。
- 约定缺口：仓库此前没有要求 provider 文档版本与实际捆绑 CLI
  配置版本一致，也没有记录 OpenCode 对未知字段静默忽略的行为。

## 已增加的防线

- **构建产物检查**：`checks/verify-opencode-v1-config.ts` 从最终 `dist/main.js`
  提取真实嵌入配置，逐层限制顶层、provider 和 model 的 v1 字段。出现
  `providers/package/settings/body`
  等错误位置时以非零状态退出，错误会指出字段路径和修复后重新执行
  `deno task build`。触发点是每次 build，在 `.orax` 生成前。
- **检查器测试**：`tests/opencode-v1-config_test.ts` 构造一个可接受的 v1
  配置和一个曾经逃逸的 v2 配置，证明后者在 `config.providers` 处失败。触发点是
  `deno task test`。
- **构建接线**：`deno.json` 的 `build` 在注入后、混淆前自动运行
  `verify-opencode-v1-config`，防止检查器存在但未被执行。
- **回链**：`INTERNAL.md` 链接本文，使配置维护入口能够追溯这条限制的来源。
- **已知缺口**：该检查验证当前注入器使用的字段子集是否属于 OpenCode
  v1，不验证远端 provider 是否接受请求，也不替代未来升级 OpenCode
  主版本时对其发布配置 schema 的重新核对。

## 经验

- 配置文件是外部接口；“合法 JSON”不等于“目标版本接受的配置”。
- 静默忽略未知字段的依赖必须由调用方增加版本化校验，否则成功退出不能作为加载成功的证据。
- 检查构建产物中的关键词只能证明实现写出了内容，不能证明依赖消费了内容。
- 防线应读取最终
  artifact，并在打包前对目标版本的不变量失败，而不是依赖维护者记住两套相似字段。
