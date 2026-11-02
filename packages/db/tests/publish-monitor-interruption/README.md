# 每周复盘（kind=review 回合）的中断与收尾

本机合成数据测试，不连接 staging、不调用供应商、不读取项目环境文件。

```bash
node packages/db/tests/publish-monitor-interruption/run-local.mjs --local-only
```

套件从仓库文件建空库，用真实的回合函数（turn_open / turn_call_begin / turn_call_record / turn_close）和迁移 0473 的复盘函数，
证明：送达的回合完成复盘，页面正文取自回合保存的助手消息、表格取自保存的复盘包，用户按回执付费；
被中断的尝试按已知花费从同一个 1 美元上限里扣除后换新的 request 重试，最多 3 次；费用未知的回合保持领取、不重试；
仍在运行的回合保持领取，满 15 分钟判为过期，由调用方先关回合再跳过；没有送达的回合结束本周期；上限用尽不再重试；
迁移可重复执行；复盘函数只对 service_role 开放。

截止时间由数据库判断（创建满 15 分钟的运行中回合）。收尾由 social-monitor 的下一次领取完成，不能把本机测试当成远程调度 SLA。
