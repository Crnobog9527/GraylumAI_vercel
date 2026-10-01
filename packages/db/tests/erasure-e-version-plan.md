# PR-E 第三轮 P2：本地版本检查执行计划

2026-10-01，PostgreSQL 17 固定镜像、本机可销毁完整文件建库；未连接远程数据库。
复现：`node packages/db/tests/run-erasure-e.mjs --local-only`。
`erasure-e-version-plan.mjs` 通过该 runner 的本地 SQL 回调运行，没有独立远程入口。

夹具为 100,000 行合成摘要、3 个测试版本；全部版本在请求中，是旧查询需要扫完整表的路径。
两组使用相同数据和 VACUUM ANALYZE 后的统计信息；before 在事务内临时移除新增索引，
运行旧版原查询后回滚；after 从已安装 helper 的函数体提取实际版本检查 SQL，使用新索引。
未设置 enable_seqscan 等优化器开关。每组执行一次 JSON 计划作断言、一次文本计划作下列记录；
以下时间来自文本计划，单次本机采样不代表 staging 或生产延迟。

- before：Seq Scan 读取 100,000 行，shared hit 2,041。
- after：初始索引定位 + 按版本递归跳查，返回 3 个不同版本；shared hit 12，heap fetches 0。
  随版本数增加索引探测次数，不随该版本下的身份数线性扫描。
- 自动断言：实际查询的底层两处扫描都走新增索引、单次最多读一行；空表/全版本返回无遗漏。
  依次遗漏三个版本的任一个，查询检测到遗漏，且 service_role 的领取与注销两个实际 RPC
  都拒绝 `OPENING_GRANT_KEY_VERSION_MISSING`，没有通过截断版本集合削弱拒绝语义。
- 新索引只是现有表的访问路径；无新版本登记表、数据权威、入口或授权。
  rollback 显式删除索引，完整 catalog 回退/重应用比对、权限审计及新会话拒绝用例通过。

## Before：EXPLAIN (ANALYZE, BUFFERS)

```text
Result  (cost=3793.25..3793.26 rows=1 width=1) (actual time=23.337..23.339 rows=1 loops=1)
  Buffers: shared hit=2041
  InitPlan 1
    ->  Hash Anti Join  (cost=2.25..3793.25 rows=1 width=0) (actual time=23.335..23.337 rows=0 loops=1)
          Hash Cond: (d.key_version = (i.value ->> 'key_version'::text))
          Buffers: shared hit=2041
          ->  Seq Scan on opening_grant_identity_digests d  (cost=0.00..3291.00 rows=100000 width=8) (actual time=0.004..9.445 rows=100000 loops=1)
                Filter: (purpose = 'opening_grant'::text)
                Buffers: shared hit=2041
          ->  Hash  (cost=1.00..1.00 rows=100 width=32) (actual time=0.018..0.018 rows=3 loops=1)
                Buckets: 1024  Batches: 1  Memory Usage: 9kB
                ->  Function Scan on jsonb_array_elements i  (cost=0.00..1.00 rows=100 width=32) (actual time=0.008..0.008 rows=3 loops=1)
Planning:
  Buffers: shared hit=161
Planning Time: 0.605 ms
Execution Time: 23.400 ms
```

## After：EXPLAIN (ANALYZE, BUFFERS)

```text
Result  (cost=40.69..40.70 rows=1 width=1) (actual time=0.091..0.093 rows=1 loops=1)
  Buffers: shared hit=12
  InitPlan 2
    ->  Hash Anti Join  (cost=38.16..40.69 rows=1 width=0) (actual time=0.091..0.092 rows=0 loops=1)
          Hash Cond: (v_1.key_version = (i.value ->> 'key_version'::text))
          Buffers: shared hit=12
          CTE retained_versions
            ->  Recursive Union  (cost=0.29..35.91 rows=101 width=8) (actual time=0.034..0.065 rows=3 loops=1)
                  Buffers: shared hit=12
                  ->  Limit  (cost=0.29..0.31 rows=1 width=8) (actual time=0.033..0.033 rows=1 loops=1)
                        Buffers: shared hit=3
                        ->  Index Only Scan using opening_grant_identity_versions_idx on opening_grant_identity_digests  (cost=0.29..2082.29 rows=100000 width=8) (actual time=0.032..0.032 rows=1 loops=1)
                              Index Cond: (purpose = 'opening_grant'::text)
                              Heap Fetches: 0
                              Buffers: shared hit=3
                  ->  Nested Loop  (cost=0.29..3.46 rows=10 width=8) (actual time=0.010..0.010 rows=1 loops=3)
                        Buffers: shared hit=9
                        ->  WorkTable Scan on retained_versions v  (cost=0.00..0.20 rows=10 width=32) (actual time=0.000..0.000 rows=1 loops=3)
                        ->  Limit  (cost=0.29..0.32 rows=1 width=8) (actual time=0.009..0.009 rows=1 loops=3)
                              Buffers: shared hit=9
                              ->  Index Only Scan using opening_grant_identity_versions_idx on opening_grant_identity_digests opening_grant_identity_digests_1  (cost=0.29..778.95 rows=33333 width=8) (actual time=0.009..0.009 rows=1 loops=3)
                                    Index Cond: ((purpose = 'opening_grant'::text) AND (key_version > v.key_version))
                                    Heap Fetches: 0
                                    Buffers: shared hit=9
          ->  CTE Scan on retained_versions v_1  (cost=0.00..2.02 rows=101 width=32) (actual time=0.035..0.066 rows=3 loops=1)
                Buffers: shared hit=12
          ->  Hash  (cost=1.00..1.00 rows=100 width=32) (actual time=0.015..0.015 rows=3 loops=1)
                Buckets: 1024  Batches: 1  Memory Usage: 9kB
                ->  Function Scan on jsonb_array_elements i  (cost=0.00..1.00 rows=100 width=32) (actual time=0.009..0.010 rows=3 loops=1)
Planning:
  Buffers: shared hit=103
Planning Time: 0.462 ms
Execution Time: 0.163 ms
```
