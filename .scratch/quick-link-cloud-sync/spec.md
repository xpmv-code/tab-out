# Tab Out 跨 Chrome 配置文件常用标签同步

Status: In progress

## 目标

不同 Google 账号登录的 Chrome 配置文件，在每个配置文件中登录同一个 Tab Out 账号后，共享同一份常用标签页及分组；新增、编辑、删除和排序后自动双向同步。现有纯 JavaScript、Chrome MV3 和本地优先行为继续保留。

## 第一阶段范围

- 邮箱一次性验证码登录；Tab Out 身份与 Google/Chrome 身份解耦。
- 使用 Supabase Auth、PostgreSQL 和 Data REST API。
- 常用标签和分组云同步；其他工作空间、浏览历史、时间线、统计、缓存不纳入同步。
- 本地数据优先；云端未配置、未登录或不可用时，现有本地功能不受影响。
- 首次登录时合并本地和云端数据，不自动用云端覆盖本地。
- 用稳定 ID、更新时间、删除墓碑和乐观并发更新处理冲突。
- 服务端启用 RLS；扩展只使用 publishable/anon key，永不使用 service_role/secret key。
- 配置和凭据不写入版本控制；访问云端前按需申请 Supabase 主机权限。

## 数据模型

每个已认证用户在 quick_link_sync_documents 中拥有一份 JSONB 文档：schemaVersion、groups、links、tombstones。每个组/链接记录具有稳定 ID、更新时间及顺序。删除操作以墓碑表示，防止离线设备将已经删除的记录重新上传。

数据库行按 auth.uid() 与 user_id 匹配隔离。更新使用 revision 条件写入；竞争失败时重新读取并合并后重试。

## 初次连接规则

1. 云端无记录：上传当前本地常用标签和分组。
2. 云端已有记录：按稳定 ID 合并；同名分组合并；同网址链接去重；较新的修改优先。
3. 首次连接完成前保留本地数据，不执行破坏性覆盖。
4. 不同 Tab Out 账号使用不同 ownerId 元数据；切换账号时重新从当前本地快照初始化，不能复用另一账号的同步状态。

## 限制与待办

- 需要用户自行创建 Supabase 项目、应用 SQL migration，并配置邮箱 OTP 模板。
- 需要实际项目凭据后才能完成真实邮件投递及跨配置文件验收。
- 第一阶段自动同步在新标签页打开时进行，监听本地修改，并在标签页保持打开时每 30 秒拉取远端变化；同时由现有 MV3 Service Worker 使用 Chrome Alarms 在浏览器运行期间每 5 分钟拉取云端变化，并对待同步变更安排至少 30 秒后的持久重试。浏览器完全退出时无法执行网络同步，恢复启动后重新调度。
- 密钥是面向客户端的 publishable/anon key，RLS 才是数据隔离边界；不得把 service_role 密钥写入扩展。
