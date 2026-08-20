/**
 * PV0 acceptance suite — series A: Manifest 与兼容性 (RFC §2)
 *
 * Doctrine (#76, 旦九 2026-08-20 ruling): PV0 runs as an independent Vitest suite,
 * NOT inside the six-lights acceptance driver. Every unimplemented item stays an
 * honest `it.todo` — fixture-backed stubs must be declared STUBBED in the PR body,
 * and nothing here is allowed to impersonate green.
 *
 * Item source of truth: acceptance/plugin-protocol-v0.md (titles copied verbatim).
 * Awaits: host manifest validate/discover/prepare semantics (PR① post-#62).
 */
import { describe, it } from "vitest";

describe("PV0 series A — Manifest 与兼容性 (RFC §2)", () => {
  it.todo("[PV0-A01] 合法 manifest 可进入 prepare");
  it.todo("[PV0-A02] 未知 schema fail-closed");
  it.todo("[PV0-A03] requiresMist 不可猜");
  it.todo("[PV0-A04] 路径与枚举封口");
  it.todo("[PV0-A05] 缺要求不降级装");
  it.todo("[PV0-A06] manifest 无需执行代码");
  it.todo("[PV0-A07] 停用是真卸载");
  it.todo("[PV0-A08] plugin id 封口");
  it.todo("[PV0-A09] env 绑定形状不可混用");
});
