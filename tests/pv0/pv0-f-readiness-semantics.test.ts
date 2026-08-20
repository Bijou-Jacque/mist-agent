/**
 * PV0 acceptance suite — series F: readiness 与稳定失败语义 (RFC §4/§8)
 *
 * Doctrine (#76, 旦九 2026-08-20 ruling): PV0 runs as an independent Vitest suite,
 * NOT inside the six-lights acceptance driver. Every unimplemented item stays an
 * honest `it.todo` — fixture-backed stubs must be declared STUBBED in the PR body,
 * and nothing here is allowed to impersonate green.
 *
 * Item source of truth: acceptance/plugin-protocol-v0.md (titles copied verbatim).
 * Awaits: readiness lamps + reason-code wiring (spans PR①-③).
 */
import { describe, it } from "vitest";

describe("PV0 series F — readiness 与稳定失败语义 (RFC §4/§8)", () => {
  it.todo("[PV0-F01] readiness 有 scope");
  it.todo("[PV0-F02] 原因码稳定可判");
  it.todo("[PV0-F03] 每条约束都有指定红格");
  it.todo("[PV0-F04] boot-time 不变量不可卸载");
  it.todo("[PV0-F05] 壳共享魂私有");
  it.todo("[PV0-F06] ready 必须有当前 scope 的可用性收据");
});
