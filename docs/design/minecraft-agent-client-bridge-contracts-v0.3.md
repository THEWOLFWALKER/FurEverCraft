# FurEverCraft L2：适配、执行与持久化合同

v0.3 · 2026-10-24 · 已定案待迁移，非当前源码API声明。

上位[L1](minecraft-agent-top-level-design-v0.3.md)，下位[L3](minecraft-agent-motion-navigation-recovery-v0.3.md)。下面类型是目标合同；实施须建立Zod运行时校验与对应类型，不能把本文件当已编译代码。

## 1. 上下文、证据与时间

```ts
type StableScope = Readonly<{
  serverProfileId: string; accountId: string;
  worldGenerationId: string; dimensionId: string;
}>;
type ExecutionContext = Readonly<{
  scope: StableScope;
  connectionEpoch: string; bodyEpoch: string; registryEpoch: string;
  observerEpoch: string; helperEpoch: string;
  runtimeOwnerId: string; executionId: string; plannerGeneration: number;
  controlGeneration: number; goalId: string; goalRevision: number;
  bundleId: string; bundleDigest: string;
}>;
interface ContextProvider {
  current(): { status: 'resolved'; context: ExecutionContext } |
             { status: 'unresolved'; missing: string[] };
}
interface TimeServices {
  clock: Clock; // 完整now/schedule/cancel，本进程单调时间
  utcNow(): string;
  clockDomainId: string; // 每进程/测试时钟实例唯一
}
type EvidenceRef = {
  id: string; source: 'client-reported' | 'server-observed' | 'predicted' |
                       'historical' | 'model' | 'synthetic' | 'simulated';
  scope: StableScope; connectionEpoch: string; bodyEpoch: string;
  observerEpoch: string; registryEpoch: string;
  streamId?: string; sequence?: string;
  observedMono: number; clockDomainId: string; receivedUtc: string;
  validUntilMono?: number; fieldRevision: string;
  bundleDigest: string; provenanceRef: string;
};
```

ContextProvider由会话装配维护，不接受模型指定scope。执行持有不可变捕获快照；每次异步返回及派发前比对当前上下文。未解析身份不得写入可信世界记忆或自主动作；可临时保存provisional观察，解析后显式重取基线，不批量升级为可信。

`accountId`是配置玩家身份的稳定标识，不要求正版UUID。worldGenerationId由明确服务器档案中的世界代次配置提供；客户端不能可靠发现所有服务端世界重置，疑似重置先使相关知识/记忆失效并需操作员修订代次。dimensionId是领域名称，旧BodyContext.dimension在唯一转换器映射，字符串拼接scope改为canonical JSON再hash。

单调时间跨重启不持久化作新鲜度依据，持久保存UTC和证据来源。恢复后当前观察必须重新取得；UTC倒退/超出允许误差时freshness=unknown。模型坐标只能写unverified地点，只有观察证据绑定才更新verifiedAt；不从重启时间刷新。

## 2. AdapterRegistry与bundle

```ts
interface BundleManifest {
  manifestVersion: 2;
  id: string; digest: string;
  game: { edition: 'java'; release: string; protocol: number; dataVersion: number };
  domainContract: { major: 1; minor: number };
  components: {
    protocol: ComponentRef; data: ComponentRef;
    geometryPhysics: ComponentRef; clientControl: ComponentRef;
  };
  capabilities: CapabilityDeclaration[];
}
interface ComponentRef {
  id: string; version: string; digest: string;
  sources: Array<{ repository: string; commit: string; path: string; sha256: string;
                  sourceVersion: string; inherited: boolean }>;
}
interface ProtocolAdapter {
  readonly id: string;
  decode(frame: CompleteFrame, view: RegistryView): DecodeResult;
  recogniseControl(frame: CompleteFrame, state: DirectionState): ControlTransition | undefined;
}
type DecodeResult =
  | { status: 'decoded'; events: CanonicalObservation[]; consumedBytes: number }
  | { status: 'unsupported'; dependency: string; affectedDomains: string[] }
  | { status: 'invalid'; reason: string; affectedDomains: string[] };
```

静态registry用显式factory表，不执行manifest里的任意路径。不兼容domain major、缺artifact、错误hash、release/protocol不一致、缺native均拒绝注册。manifest v1通过显式转换为候选档案，不能直接启用。包必须完整消费payload才接受；不允许成功解析前半包后忽略尾部。

CapabilityDeclaration分别含implementation（available/absent）、coverage（complete/partial/unknown）、evidence（synthetic-contract/file-verified/client-calibrated）、适用条件和依赖capability IDs。运行时ActionReadiness通过依赖闭包求值，检测循环；一个包未实现组件只影响该包及依赖领域，不把所有领域标成支持或全部清零。framing/phase/registry控制失去连续性属于全局失效。

ProtocolAdapter仅收CompleteFrame，不持socket写权限。静态item ResourceLocation集合与线上数字ID表分别保存，数字ID必须绑定registryEpoch。支持未命名packet只能跳过完整已知帧；未知变长字段不能跳过。未知组件禁止保留void占位继续解释同包。

## 3. 观察进程合同

所有IPC envelope含protocolVersion、requestId、sessionId、connectionEpoch、observerEpoch及消息sequence。方向命名统一client-to-server/server-to-client，旧upstream/downstream只在转换边界映射。worker按session建立独立decoder；close必须终止该session并清除半包，旧epoch事件丢弃。

host在postMessage前预留消息数和字节credit；worker接收/处理ack退还。默认8MiB在途原始字节、64条chunk消息，单chunk最多256KiB，超过分块但不改变流序；额度不足停止该session观察并报告全局gap，不阻塞relay或静默漏掉未分类字节。保留独立控制通道；控制队列溢出本地同步撤权，不能指望已溢出队列可靠传撤权消息。

subscriber超时不视作真实取消。活动槽只在任务真正settle才释放；超时任务停止接新任务，终止对应worker或隔离subscriber，不能Promise.race超时后无限叠加回调。正常业务subscriber必须有限、可取消；未知扩展回调不进入控制循环。

控制启停回执含accepted/completed/failed。completed必须由relay内真正worker状态确认。Supervisor周期检查心跳，stop后不再重启；旧实例延迟hello/ack不能激活新generation。

## 4. ControlAuthority与ActionGateway

```ts
type PreconditionResult =
 | { status: 'satisfied'; evidence: EvidenceRef[] }
 | { status: 'unsatisfied' | 'unknown'; code: string; needed: string[] };
interface ActionContext {
  readonly execution: ExecutionContext;
  readonly signal: AbortSignal;
  readonly time: TimeServices;
  report(progress: Progress): void; // 纯遥测，不续活已取消执行
  perform(intent: AtomicActionIntent): Promise<ActionResult>;
}
interface ActionGateway {
  perform(context: ActionContext, intent: AtomicActionIntent): Promise<ActionResult>;
  releaseOwned(executionId: string, reason: string): Promise<ReleaseResult>;
}
```

Context由Executor传入Skill，不暴露RawInputSink、Store或任意bridge写方法。ActionGateway唯一持有InputArbiter、EffectCoordinator、InputDriver。BodyPort只读，动作适配方法封装为网关内部driver实现；模拟也遵守同一入口。进度/前提求值不得派发输入。

ControlAuthority的revoke同步增controlGeneration、关资格并abort；随后异步释放。arm只请求重评估，要求running、resolved scope、健康helper、已绑定窗口、相关观察完整新鲜、非shutdown、四gate满足。选择性能力丢失只拒对应动作，但全局gap撤所有身体写资格。

perform算法：
1. 捕获且校验context/goal/generation/signal和实际资源，unknown前提拒绝。
2. claim commandKey并以事务准备效果；已存在同key异payload报conflict；相同请求返回原状态，不重派。
3. 获取owner lease，重验前提；以expectedRevision迁移may-have-dispatched，commit成功才下一步。
4. 重验准入，生成sealed InputCommand给driver；driver在最后派发前再验证owner/generation/epoch/deadline。屏障后被取消而没有派发证明，最多ambiguous；有明确driver拒绝证明才not-dispatched。
5. 保存driver receipt，交verifier收集新观察，返回分轴结果。DB在派发后失败不得重试输入；关执行、记录恢复需求。
6. finally只释放本owner资源，旧回调不能修改新执行。

网关防普通实现绕行而非安全沙箱；用封装和依赖测试保证原始driver仅composition/gateway可引用。SQLite事务绝不跨await。prepare、CAS和派发之间存在不可消除崩溃窗口，靠ambiguous表示，不声称exactly-once游戏效果。

连续移动以一个primitive效果+有界pulse日志管理，不为20Hz每个held刷新写SQLite。pulse必须绑定primitive、lease和generation，每次driver验证；primitive effect先持久屏障，pulse可批量记录，崩溃尾部不可证则ambiguous。dig/place/text每个独立副作用独立effect；gather父执行汇总孩子，不用单个effect覆盖整轮。

## 5. 显式状态迁移

| 对象 | 合法迁移/约束 |
|---|---|
| execution | queued→running/failed/canceled；running→stopping/verifying/failed/suspended；stopping→canceled/failed/suspended；verifying→succeeded/failed/suspended/stopping；suspended无原地恢复执行，重新核对后创建新execution并关联旧execution |
| effect | prepared→may-have-dispatched/not-dispatched；may-have-dispatched→verifying/confirmed/partial/ambiguous/not-dispatched；verifying→confirmed/partial/ambiguous；partial/ambiguous仅verifier用新证据CAS迁移到confirmed或更新不确定证据，不再派发旧effect |
| receipt | pending→completed/unknown/rejected；终态不可覆盖，重复请求返回完整原结果；unknown不重派 |

confirmed需新证据支持动作归因，targetSatisfied单独true不够。partial effect表示单原子动作观测到部分效果；复合技能partial优先从子效果聚合。旧confirmed保留历史source，但不作为新版本权威证明。执行succeeded/failed/canceled一旦终态不可恢复，效果可在之后独立调和，并显示最新效果结果，不反写执行历史。

迁移API返回Applied(newRevision) / Conflict(currentRevision,status) / InvalidTransition；调用方必须穷尽处理。禁止rank比较后静默返回旧值。恢复器与执行器通过EffectCoordinator串行协调；活动execution不可被recover改写。每个effect保留append-only证据、转换理由和actor。

## 6. 模型、工具与控制API

工具注册表统一schema、read/write/control-write、resources、requiredCapabilities、preconditions、handler。Router、provider fanout与技能发现从同一注册表取信息。write批次按模型原顺序串行；纯读批次最多8并发，结果按原顺序配对。

逻辑调用身份为sessionId + decisionId + responseAttemptId + toolCallId。上游provider HTTP请求在交付响应前重试可同域重用；工具已执行后不得用参数指纹推断新响应是同动作重试。应用层明确重试同logicActionId才去重。工具ID在不同响应可重复，canonical内部ID命名空间化，serializer做可追踪映射。异payload同逻辑ID报conflict。读结果不跨decision缓存为现场事实。

取消填补尚未执行调用为not-executed；已发未明为ambiguous；不能伪造成功历史。按完整user/assistant/tool单元裁剪，默认最多200条且序列化UTF-8总预算256KiB（图片按引用/元信息记账，另有限额），新单元超过预算则拒绝/要求有界结果，不拆工具对。长期摘要带来源、不包含隐藏思维链，原trace有界保存。

Control API沿用/api/v1，新增字段可加；更改语义必须改DTO contract版本。requestId key包含当前session/scope/clientId，inflight先比payloadHash；持久receipt保存完整ok/code/result和safe error，重放同义。SSE有效cursor按序replay；gap发送reset快照，其cursor=head，之后仅>head。快照与head在同一读事务建立，订阅捕获窗口有界，慢消费者超预算断开显式gap。默认最多8 SSE，总pending 1MiB/连接，SQL分页默认20最多100，trace导出SQL限额默认1000最多10000。

## 7. 数据库迁移与旧记录

现库schema_migrations含1–4。只有owner可在启动时迁移，迁移前用SQLite backup API生成一致备份（包含WAL，不用单文件copy）。未来schema高于本程序支持时拒绝写启动。实现分别事务提交5/6/7；每步重启幂等，失败回滚当前步并保留备份。不能自动downgrade。

| 版本 | 新增与处理 |
|---|---|
| 5 | executions加context_json、scope_key、context_status、bundle_digest、revision；goals加scope_key/context_status；从原body_context或关联goal推导，若任一effect scope冲突/缺少必需身份则unresolved隔离；旧running不直接当当前活动 |
| 6 | effects加revision、parent_effect_id、logical_action_id、action_ordinal、target_satisfied、attribution、evidence_level；新增effect_transitions(effect_id,revision,from_status,to_status,actor,evidence_ref,created_at)；唯一键(execution_id,logical_action_id,action_ordinal)，旧记录logical_action_id设legacy:effect_id不改变历史 |
| 7 | action_receipts增加request_json_hash、full_result_json、context_status；places增加time_basis与verification_status；旧单调时间或来源不明标unknown，不用当前UTC猜换算；新增runtime_control_interlock存上次关机与残余child/helper身份 |

scope_key是canonical完整scope的hash，未解析为NULL，所有生产查询显式scope_key=?；包括goals/executions/effects/episodes/status/scheduler。global vanilla知识是显式global类型，不通过scope缺省“匹配全部”。未解析历史只在明确diagnostic includeUnresolved视图可读，不参与动作/记忆检索。索引覆盖scope_key+status+主键cursor；同scope查询禁止先all再filter。

effect旧状态不重解释或删除。legacy确认标legacy-unreviewed并保留原status，当前成功统计按evidence_level区分。敏感旧记录不自动展现到API：旧原文视图仅本地受控迁移，正常DTO脱敏；新认证命令只持secretRef与脱敏模板，不把密码写入intent。

Runtime关闭前记录interlock=closing；确认child退出和helper释放后置clean。崩溃/不确定关闭为uncertain；下次可取得DB owner做恢复，但不可恢复控制资格，先核对旧child身份并确认退出，helper新epoch重绑定，不重放旧输入。未能确认则只读状态/恢复可用、动作关闭。PID需结合进程实例身份，不能只判断PID是否存在或杀任意同PID进程。
