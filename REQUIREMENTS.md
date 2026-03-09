# china-notify 最终需求文档

> **状态**: 最终版
>  
> **版本**: v2.1
>  
> **日期**: 2026-03-08

---

## 1. 项目目标

在中国大陆通过 homelab 自建 relay，将 Slack 中与用户本人相关的重要消息尽可能及时、稳定地推送到用户手机上。

本次重构的核心变更:

- 将推送通道从 `ntfy` 替换为 QQ 邮箱邮件推送
- 运行时从 Bun 切换到 Node.js
- 消息采集架构从“bot 视角实时接收”调整为“user-token-first”

硬约束:

- 部署在 homelab 上，但必须能简单迁移到其他服务器
- homelab 有稳定的科学上网环境
- 每条消息单独发一封邮件通知，不做聚合
- 日发送量保证 `< 100` 封
- relay 挂掉或邮件发送能力失效时，必须有独立告警机制

---

## 2. v2 范围

v2 必须覆盖以下消息:

| 类型 | 说明 |
|---|---|
| DM | 发给用户本人的 1:1 私信 |
| @用户 mention | 任意用户可见频道 / 会话中直接 `@用户` |
| @用户组 mention | 任意用户可见频道 / 会话中 `@用户所在 group` |

v2 不进入必做范围的能力:

- 任意频道监控
- keyword 升级
- 多邮箱分流
- SMS / 语音等二次告警

这些能力可在后续版本作为增强项处理。

---

## 3. 最终架构决策

### 3.1 user-token-first

v2 采用 `user-token-first` 架构。

正式定义:

- `User Token polling` 负责消息覆盖正确性
- `Socket Mode` 仅作可选实时加速层
- 系统必须在“只有 `User Token`”时仍可正确工作
- 不再以 `Bot Token` 作为覆盖基础

这一定义的原因是:

- 用户无法把 bot 加入所有需要覆盖的频道
- 一部分目标频道对 bot 不可见
- 因此必须以“用户本人可见的会话集合”为采集视角

### 3.2 两种运行模式

#### Mode A: `polling-only`

这是 v2 的基础模式，也是必须实现的模式。

特点:

- 只依赖 `SLACK_USER_TOKEN`
- 正确性最清晰
- 结构最稳
- 延迟高于实时事件模式，但能满足全覆盖要求

#### Mode B: `polling + socket-mode`

这是可选增强模式，不是 v2 上线前提。

特点:

- 正确性仍由 polling 保证
- Socket Mode 只负责缩短部分消息的通知延迟
- Socket Mode 失效时，系统仍应继续通过 polling 正常工作

### 3.3 Bot Token 的地位

`SLACK_BOT_TOKEN` 不进入 v2 基础实现前提。

如果后续为实现某种 Socket Mode 加速方案而需要引入 bot token，应视为增强项的额外技术决策，而不是当前架构前提。

### 3.4 为什么不用 HTTP Events API

HTTP Events API 可靠性更高，但当前不作为 v2 主方案。

原因:

- homelab 场景下暴露公网 HTTPS endpoint 增加部署和安全复杂度
- v2 的正确性已经由 polling 保证，不需要依赖 HTTP 重试语义
- 如未来对实时性和平台标准化要求进一步提高，可再评估切换

---

## 4. Slack 接入设计

### 4.1 运行时

必须从 Bun 切换到 Node.js。

原因:

- `@slack/bolt` 在 Bun 下存在 WebSocket 兼容问题
- 现有已知问题会导致事件处理不稳定
- 该项目的核心链路不应建立在不稳定运行时之上

### 4.2 会话可见性模型

系统以 `User Token` 对应用户的可见会话为准。

需要纳入会话枚举的类型:

- `im`
- `mpim`
- `public_channel`
- `private_channel`

会话发现方式:

- 使用 `users.conversations(types=im,mpim,public_channel,private_channel)`
- 周期性刷新会话集合

### 4.3 轮询是正确性主路径

轮询器必须对“用户可见会话集合”做增量拉取，而不是只轮询 DM。

主路径流程:

1. 周期性枚举用户可见会话
2. 为每个会话维护 `last_processed_ts`
3. 调用 `conversations.history(oldest=last_processed_ts)` 拉取增量消息
4. 对每条消息执行过滤、匹配、格式化、发信
5. 消息成功处理后推进该会话 cursor

### 4.4 可选实时加速层

如果启用 Socket Mode:

- 它只能作为加速层
- 不得作为唯一消息来源
- 不得改变 polling 是正确性主路径这一事实

推荐实现语义:

- Socket Mode 收到某会话相关事件后，立即触发该会话的一次增量同步
- 最终仍以 `conversations.history` 拉到的消息为准

### 4.5 需要的 OAuth scopes

#### User Token 必需 scopes

- `channels:read`
- `groups:read`
- `im:read`
- `mpim:read`
- `channels:history`
- `groups:history`
- `im:history`
- `mpim:history`
- `users:read`

说明:

- `*:read` 用于发现用户可见会话
- `*:history` 用于增量拉取消息
- `users:read` 用于用户名解析

### 4.6 用户输入信息

用户需提供:

- 自己的 Slack User ID
- 自己关注的 Slack User Group ID 列表

v2 不要求自动发现“用户属于哪些 group”。

---

## 5. 速率控制与采集策略

### 5.1 设计目标

目标不是打满 Slack 配额，而是在低风险前提下稳定运行。

系统必须保守控制 `User Token` 的请求频率，避免临时限流或账号风险。

### 5.2 默认调度策略

推荐默认轮询节奏:

- `DM / MPIM`: 每 30 秒
- 最近 2 小时内有新消息的活跃频道: 每 60 秒
- 长时间无活动频道: 每 10 分钟
- 会话列表刷新: 每 10 分钟

### 5.3 请求速率限制

内部控制策略:

- 软上限: `12 req/min`
- 硬上限: `20 req/min`
- 任一 API 返回 `429` 时，严格遵守 `Retry-After`
- 连续触发限流时，自动降级到更低轮询频率

### 5.4 批量与分页

实现要求:

- 使用 `oldest` 进行时间窗口增量同步
- 单次请求 `limit` 应保守设置，不追求极限
- 对返回分页结果必须正确翻页直到消费完本次增量窗口

---

## 6. 状态模型与迁移语义

### 6.1 总体原则

系统不是“无状态”，而是“轻状态、易迁移”。

v2 不引入数据库，状态以本地小型文件保存。

### 6.2 两种启动场景

#### 首次启动

适用场景:

- 第一次部署
- 重装后不保留旧状态
- 迁移到新机器但不携带状态目录

行为:

- 所有会话 cursor 初始化为进程启动时刻
- 不回补历史消息
- 只处理启动之后的新消息

#### 恢复启动

适用场景:

- 正常重启
- 容器重建
- 带状态目录迁移

行为:

- 从已保存 cursor 继续处理
- 保证在重启窗口后尽量不漏消息

### 6.3 必须持久化的最小状态

- `conversation_id -> last_processed_ts`
- SMTP 连续失败计数
- 最近成功处理事件时间
- 最近成功发信时间
- 最近一次会话枚举时间

短期去重缓存可放内存，但不能代替 cursor 持久化。

### 6.4 状态文件损坏处理

如果状态文件不存在:

- 视为首次启动

如果状态文件损坏:

- 记录错误
- 回退为“从当前时刻重新开始”
- 明确这会丢失故障窗口内的未处理消息

### 6.5 迁移要求

迁移仍应保持简单:

- 不带状态目录也能启动
- 带状态目录可无缝续跑

因此迁移所需的运行态数据只有一个小型状态目录。

---

## 7. 匹配与消息语义

### 7.1 v2 匹配规则

v2 只保留以下规则:

```json
{
  "directMessages": true,
  "watchedMentions": {
    "userIds": ["U0123456789"],
    "groupIds": ["S0123456789"]
  },
  "notifyEdits": false
}
```

### 7.2 匹配语义

- DM: 直接通知
- 频道 / 会话中出现 `@用户`: 通知
- 频道 / 会话中出现 `@用户组`: 通知
- 一个消息若同时命中多条规则，也只发一封邮件

### 7.3 线程消息

- thread reply 中如果 `@用户` 或 `@用户组`，正常通知
- 纯 thread reply 不通知

### 7.4 编辑与删除

- `message_deleted`: 不通知
- `message_changed`: v2 默认不通知
- 可保留 `notifyEdits` 开关，但默认关闭

### 7.5 Bot 消息

默认过滤 bot 消息，避免噪音和循环。

---

## 8. 邮件推送设计

### 8.1 发送方案

采用收发分离:

- 接收邮箱: `receiver@example.com`
- 发送邮箱: 新注册的 QQ 邮箱

推荐原因:

- 同平台送达率最高
- 设置最简单
- 长期可靠性最好

### 8.2 SMTP 配置

| 参数 | 值 |
|---|---|
| SMTP 服务器 | `smtp.qq.com` |
| 端口 | `465` |
| 加密方式 | SSL |
| 认证方式 | QQ 邮箱地址 + 授权码 |
| 发送库 | `nodemailer` |

### 8.3 邮件标题

格式:

```text
[Slack] {事件类型}: {发送者} in {频道}
```

示例:

- `[Slack] DM: @zhangsan`
- `[Slack] Mention: @zhangsan in #general`
- `[Slack] Group @backend-team: @lisi in #incidents`

要求:

- 标题总长度尽量控制在 60 字符内
- 优先保留事件类型、发送者、频道

### 8.4 邮件正文

格式为纯文本。

建议内容:

```text
发送者: {用户名} ({User ID})
频道: {频道名} ({Channel ID})
时间: {消息时间}

---

{消息正文}

---

在 Slack 中查看: {deep link URL}
```

### 8.5 名称解析

用户名解析:

- 启动时构建 `userId -> displayName` 缓存
- 定期刷新
- 未命中时回退为 ID

频道名解析:

- 构建 `channelId -> channelName` 缓存
- DM 优先显示对方用户名
- 未命中时回退为 ID

### 8.6 已发送邮件清理

v2 推荐方案:

- 通过 QQ 邮箱设置关闭“已发送邮件保存”

IMAP 定时清理作为可选增强项，不是 v2 必做项。

---

## 9. 自监控与健康状态

### 9.1 设计原则

- 外部监控是最终告警路径
- relay 只有在 Slack 和 SMTP 都健康时，才允许持续上报成功心跳
- SMTP 连续失败 5 次立即视为硬故障

### 9.2 /health endpoint

relay 必须暴露 `/health`，返回至少以下字段:

- `status`
- `slack_status`
- `smtp_status`
- `smtp_consecutive_failures`
- `last_event_processed_at`
- `last_email_sent_at`
- `last_poll_completed_at`

### 9.3 状态机

#### healthy

条件:

- Slack 轮询正常
- SMTP 可用
- `smtp_consecutive_failures < 5`

#### degraded

条件:

- 发生短时错误，但未达到硬故障阈值
- 例如临时限流、短时 SMTP 失败、短时网络异常

#### unhealthy

条件:

- `smtp_consecutive_failures >= 5`
- `SLACK_USER_TOKEN` 失效或被撤销
- 核心状态持久化失败导致系统无法继续正确运行

### 9.4 外部心跳监控

推荐使用 Healthchecks.io 或同类外部服务。

要求:

- relay 每 5 分钟上报一次成功心跳
- 只有在 `healthy` 状态下才允许上报成功心跳
- 进入 `unhealthy` 后必须停止成功心跳，触发外部告警

### 9.5 进程级保护

- Docker `restart: unless-stopped`
- 启动时发送一封 `[Slack Relay] Started` 邮件
- 重启次数和异常状态应体现在日志及 `/health` 中

---

## 10. 异常处理

### 10.1 Slack 侧

| 场景 | 处理 |
|---|---|
| API `429` | 严格按 `Retry-After` 退避 |
| User Token 失效 | 标记 `unhealthy`，停止成功心跳 |
| 短时网络故障 | 重试并降级轮询频率 |
| 会话枚举失败 | 保留旧会话集合，稍后重试 |

### 10.2 邮件侧

| 场景 | 处理 |
|---|---|
| SMTP 连接失败 | 指数退避重试 |
| SMTP 认证失败 | 计入连续失败计数 |
| SMTP 连续失败 5 次 | 进入 `unhealthy` |
| 日发送限额耗尽 | 暂停发送并标记异常 |

### 10.3 消息侧

| 场景 | 处理 |
|---|---|
| 重复事件 | 用 `channel_id + ts` 做短期去重 |
| 消息过长 | 截断正文并保留 Slack deep link |
| Slack mrkdwn | 做基础纯文本转换 |
| 非文本消息 | 尽量提取可读摘要，不因格式异常导致整个处理失败 |

---

## 11. 目录结构

```text
china-notify/
├── src/
│   ├── index.ts
│   ├── config.ts
│   ├── slack-client.ts
│   ├── conversation-discovery.ts
│   ├── poller.ts
│   ├── matcher.ts
│   ├── email-sender.ts
│   ├── email-formatter.ts
│   ├── name-resolver.ts
│   ├── state-store.ts
│   ├── health.ts
│   └── sent-mail-cleaner.ts      # 可选增强项
├── config/
│   ├── rules.json
│   └── rules.example.json
├── data/
│   └── state/                    # 轻状态目录
├── .env.example
├── docker-compose.yml
├── Dockerfile
├── package.json
└── tsconfig.json
```

---

## 12. 环境变量

```env
# Slack
SLACK_USER_TOKEN=xoxp-...         # 必填，正确性主路径
SLACK_APP_TOKEN=xapp-...          # 可选，Socket Mode 加速层
ENABLE_SOCKET_MODE=false

# 邮件
SMTP_HOST=smtp.qq.com
SMTP_PORT=465
SMTP_USER=123456789@qq.com
SMTP_PASS=xxxxxxxxxxxxxxxx
EMAIL_TO=xxxxxx.example@mail.com

# 监控
HEALTH_PORT=8080
HEALTHCHECK_PING_URL=https://hc-ping.com/your-uuid

# 状态与规则
RULES_PATH=config/rules.json
STATE_DIR=data/state
LOG_LEVEL=info
```

---

## 13. 实现阶段

### Phase 1

- Node.js 脚手架重建
- 配置与状态存储
- polling-only 模式打通

### Phase 2

- 邮件发送层
- 名称解析
- `/health` 与外部心跳

### Phase 3

- 轮询调度优化
- 限流与退避
- 完整错误处理

### Phase 4

- 可选 Socket Mode 加速层
- 仅在不改变正确性模型的前提下引入

### Phase 5

- 端到端测试
- 部署文档更新

---

## 14. 最终实施基准

实现必须满足以下 4 条最终标准:

1. 以 `User Token polling` 保证 `DM + @用户 + @用户组` 的全覆盖
2. 以“轻状态”保证首次启动与恢复启动的行为一致可预期
3. 以 SMTP 连续失败阈值驱动 `unhealthy` 和外部告警
4. 将 v2 范围收敛在必要能力内，不引入旧 `ntfy` 时代的扩展规则复杂度

本文档本身就是项目开工的唯一需求基准。
