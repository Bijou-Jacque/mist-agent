/**
 * PV0 acceptance suite — series C: 事务注册、隔离与注销 (RFC §3/§4)
 *
 * Doctrine (#76, 旦九 2026-08-20 ruling): PV0 runs as an independent Vitest suite,
 * NOT inside the six-lights acceptance driver. Every unimplemented item stays an
 * honest `it.todo` — fixture-backed stubs must be declared STUBBED in the PR body,
 * and nothing here is allowed to impersonate green.
 *
 * Item source of truth: acceptance/plugin-protocol-v0.md (titles copied verbatim).
 * Awaits: transaction engine + operation log (PR② semantics post-#62).
 */
import { describe, it } from "vitest";

describe("PV0 series C — 事务注册、隔离与注销 (RFC §3/§4)", () => {
  it.todo("[PV0-C01] prepare 不提前公开");
  it.todo("[PV0-C02] 部分注册失败全回滚");
  it.todo("[PV0-C03] activate 失败全回滚");
  it.todo("[PV0-C04] 成功提交原子可见");
  it.todo("[PV0-C05] dispose 幂等");
  it.todo("[PV0-C06] 注销先断路");
  it.todo("[PV0-C07] 清理失败 fail-closed");
  it.todo("[PV0-C08] 单插件故障不拖地基");
  it.todo("[PV0-C09] 不自动重试风暴");
  it.todo("[PV0-C10] 生命周期中断可恢复");
  it.todo("[PV0-C11] 权威状态先于公开索引");
  it.todo("[PV0-C12] quarantined 只能显式清理重试");
});
