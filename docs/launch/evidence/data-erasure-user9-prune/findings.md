## DATA-ERASURE / user9 反复超时：只读原因与最小建议

对象：仅 user9，确认时间2026-10-21 16:56:40.972265 UTC，截止2026-10-22 16:56:40 UTC。未手工改库、未重放注销、未调用删除/恢复写接口、未操作其他账号、付费调用0。

### 当前3行和存储位置
- library_documents：1行（deleting）；library_upload_reservations：1行；library_document_segments/recognition_units：0。剩余第3项是account_erasure_requests.library_storage_verified_at未取得的完成证明，不是第3份私有正文。
- 该主体storage.objects前缀计数0；ticket前缀和manifest均done=true、review=false。存储删除已不堵在大文件删除，而是资料库“有效上传链接防迟到写入”的保护：original_guard_until=2026-10-21 19:42:12.550483 UTC，absent_observed_at=NULL。
- library_cleanup_observe明确要求保护期结束后再观察对象缺失，并隔至少1秒再次确认，才删除预留/文件记录。当前ERASURE_STORAGE_PENDING在这个保护期内属于有依据的等待，不能绕过，否则迟到上传可在注销后重新落盘。
- Auth仍存在，auth_delete_started_at为空；是前置本地/存储证明未完成导致尚未进入Auth删除，并无证据表明Auth删除接口自身超时。

### 确定的慢RPC与热点
- 安全诊断码精确指向account_erasure_local_cleanup。它调用account_erasure_prune_business(uuid,integer)。该函数即使当前主体已经没有Runtime记录，仍对runtime_executions全表逐行to_jsonb(x)，再调用erasure_business_owner判断归属。LIMIT100限制的是命中行，而非扫描行或大正文序列化。
- 对user9谓词只读EXPLAIN ANALYZE复现：原归属查询扫559行，返回0行，耗时1256.648ms、4956 shared hits；等价actor_id过滤使用既有runtime_executions_actor_id_request_id_key，返回0行，耗时0.876ms、4 shared hits。没有新增索引必要。
- local_remaining只读完整核验耗时76.287ms；剩余数据很小，不能把“3行没删”归因为user9数据量大。热点是扫描无关执行的大JSON。
- 平台聚合pg_stat_statements（非user9单次归因）：local_cleanup476次，平均1111.97ms、最大6809.26ms；library_cleanup_candidates均值34.60ms、observe43.03ms。观察时没有local_cleanup活跃锁等待；这不能排除历史瞬时锁，但已直接复现不需要锁的CPU/序列化慢路径。
- 执行器每主体只给10秒，处理器RPC上限2秒；最后local_cleanup的实际等待上限还会被“剩余总预算”截短。当前实现在不足完整RPC预算时仍发送写请求，随后报TIMEOUT_UNKNOWN；底层事务可能继续提交（因此profile早已脱敏，但诊断仍重复）。旧日志没有单次内部SQL耗时，不能伪造哪一次具体等待锁的结论。
- cron确实每5分钟调用，近期多次500；200/500不是user9已完成的证明。

### 最小修复建议（接着另开DATA-ERASURE PR）
1. 只优化已证实的热点：prune_business遍历runtime_executions时，用已有actor_id索引先筛选本主体，再对命中行读取JSON；保留原批量上限、SKIP LOCKED、财务保留、删除触发器和其他表的归属规则。
2. 剩余总预算不足完整RPC窗口时，不发送新的数据库写调用，返回明确预算不足；保留“写结果不确定后不继续写/不删Auth”的安全行为。核验主体预算是否需在现有cron45秒范围内留足清理和收尾时间，不放宽平台60秒上限。
3. 不取消上传保护期，不人工释放预留；修复合并后只观察现有cron在19:42保护期过后完成资料库、存储证明和Auth删除，并以24小时原截止时间验收。

迁移号请总控按“先准备好先拿”分配；本窗口不自定号码、不上库或部署。修复代码与AGENT-CORE #1239分开，避免混范围。
