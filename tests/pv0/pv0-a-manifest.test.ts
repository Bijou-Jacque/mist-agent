/**
 * PV0 acceptance suite — series A: Manifest 与兼容性 (RFC §2)
 *
 * Doctrine (#76, 旦九 2026-08-20 ruling): PV0 runs as an independent Vitest suite,
 * NOT inside the six-lights acceptance driver. Every unimplemented item stays an
 * honest `it.todo` — fixture-backed stubs must be declared STUBBED in the PR body,
 * and nothing here is allowed to impersonate green.
 *
 * Item source of truth: acceptance/plugin-protocol-v0.md at the #62 freeze point
 * (main@acdfcab2); titles copied verbatim.
 *
 * A01–A06/A08/A09 run REAL against the discover/validate 装载层：真实包目录 fixture、
 * 顶层抛错的探针 entrypoint、零 import 取证。A07/A10 仍为 todo——它们要求
 * dispose/prepare 交付面（②段事务与恢复之后的装配层），不提前冒绿。
 */

import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MANIFEST_FILENAME,
  capabilityDirectory,
  checkInstanceConfig,
  discoverPlugin,
} from "../../src/plugin/discovery.ts";
import { resolveEnvironment } from "../../src/plugin/environment.ts";
import type { LifecycleState } from "../../src/plugin/lifecycle.ts";
import type { PluginInstanceConfig, PluginManifestV0 } from "../../src/plugin/manifest.ts";
import { moduleRefFromSource } from "../../src/plugin/module-ref.ts";
import { PluginOperationStore } from "../../src/plugin/operation-store.ts";
import { PluginTransactionHost } from "../../src/plugin/transaction-host.ts";
import type { PluginModuleV0, PreparedPlugin } from "../../src/plugin/types.ts";

const HOST = { hostVersion: "0.4.0", activeIds: new Set<string>() } as const;

/** 探针全局名：entrypoint 一旦被 import 就会置位并抛错；各条断言它始终未置位。 */
const PROBE = "__PV0_A06_PROBE__";
const PROBE_ENTRY = `globalThis["${PROBE}"] = (globalThis["${PROBE}"] ?? 0) + 1;\nthrow new Error("PV0-A06 probe: plugin code must never load during manifest validation");\n`;

let root: string;
let seq = 0;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pv0-a-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function pkg(manifest: unknown): Promise<string> {
  const dir = join(root, `pkg-${seq++}`);
  await mkdir(join(dir, "dist"), { recursive: true });
  await writeFile(join(dir, "dist", "index.js"), PROBE_ENTRY);
  if (manifest !== undefined) {
    const body = typeof manifest === "string" ? manifest : JSON.stringify(manifest, null, 2);
    await writeFile(join(dir, MANIFEST_FILENAME), body);
  }
  return dir;
}

function manifestOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestSchemaVersion: 0,
    id: "demo.plugin",
    version: "1.0.0",
    requiresMist: ">=0.1.0",
    entrypoint: "dist/index.js",
    kinds: ["tool_capability"],
    configSchemaVersion: 1,
    capabilities: [
      {
        id: "cap.echo",
        description: "echo",
        effect: "read",
        operations: ["echo"],
        injectionMode: "eager",
      },
    ],
    contextInjections: [],
    env: [],
    credentials: [],
    permissions: [],
    ...overrides,
  };
}

function probeCount(): number {
  const v = (globalThis as Record<string, unknown>)[PROBE];
  return typeof v === "number" ? v : 0;
}

describe("PV0 series A — Manifest 与兼容性 (RFC §2)", () => {
  it("[PV0-A01] 合法 manifest 可进入 prepare", async () => {
    const records = new Map<string, { state: LifecycleState; manifest: PluginManifestV0 }>();
    for (const kind of ["channel_adapter", "frontend", "tool_capability", "bridge"]) {
      const dir = await pkg(manifestOf({ id: `demo.${kind.replace(/_/g, "-")}`, kinds: [kind] }));
      const r = await discoverPlugin(dir, HOST);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.state).toBe("validated");
        records.set(r.manifest.id, { state: r.state, manifest: r.manifest });
      }
    }
    // 校验后尚未出现在能力目录：目录只枚举 active，validated 恒缺席。
    expect(capabilityDirectory(records)).toEqual([]);
    expect(probeCount()).toBe(0);
  });

  it("[PV0-A02] 未知 schema fail-closed", async () => {
    const r = await discoverPlugin(await pkg(manifestOf({ manifestSchemaVersion: 99 })), HOST);
    expect(r).toMatchObject({ ok: false, state: "blocked", reasonCode: "HOST_INCOMPATIBLE" });
    expect(probeCount()).toBe(0); // 插件代码未加载、无资源注册
  });

  it("[PV0-A03] requiresMist 不可猜", async () => {
    const unmatched = await discoverPlugin(
      await pkg(manifestOf({ requiresMist: ">=9.0.0" })),
      HOST,
    );
    expect(unmatched).toMatchObject({ ok: false, reasonCode: "HOST_INCOMPATIBLE" });
    const unparseable = await discoverPlugin(
      await pkg(manifestOf({ requiresMist: "one point oh" })),
      HOST,
    );
    expect(unparseable).toMatchObject({ ok: false, reasonCode: "HOST_INCOMPATIBLE" });
    expect(probeCount()).toBe(0); // 两者均在加载代码前返回
  });

  it("[PV0-A04] 路径与枚举封口", async () => {
    const badShapes: readonly Record<string, unknown>[] = [
      { entrypoint: "../outside.js" },
      { contextInjections: [{ id: "g", source: "../creed.md", scope: "resident" }] },
      { kinds: ["gadget"] },
      {
        capabilities: [
          { id: "c", description: "", effect: "chaotic", operations: [], injectionMode: "eager" },
        ],
      },
      {
        capabilities: [
          { id: "c", description: "", effect: "read", operations: [], injectionMode: "someday" },
        ],
      },
      {
        capabilities: [
          { id: "c", description: "", effect: "read", operations: [], injectionMode: "eager" },
          { id: "c", description: "", effect: "read", operations: [], injectionMode: "lazy" },
        ],
      },
      {
        contextInjections: [
          { id: "g", source: "a.md", scope: "resident" },
          { id: "g", source: "b.md", scope: "session" },
        ],
      },
    ];
    for (const bad of badShapes) {
      const r = await discoverPlugin(await pkg(manifestOf(bad)), HOST);
      expect(r).toMatchObject({ ok: false, reasonCode: "MANIFEST_INVALID" });
    }
    // 153/19F 反例一：词法干净但 symlink 逃根 —— 物理封口回归（entrypoint + source 两路）
    const { symlink, mkdir: mkdirP, writeFile: writeF } = await import("node:fs/promises");
    const outside = join(root, `outside-${seq++}`);
    await mkdirP(outside, { recursive: true });
    await writeF(join(outside, "index.js"), PROBE_ENTRY);
    await writeF(join(outside, "creed.md"), "escaped");
    const linkedPkg = await pkg(manifestOf({ entrypoint: "linked/index.js" }));
    await symlink(outside, join(linkedPkg, "linked"), "dir");
    const viaEntrySymlink = await discoverPlugin(linkedPkg, HOST);
    expect(viaEntrySymlink).toMatchObject({ ok: false, reasonCode: "MANIFEST_INVALID" });
    const linkedSrcPkg = await pkg(
      manifestOf({
        contextInjections: [{ id: "g", source: "linked/creed.md", scope: "resident" }],
      }),
    );
    await symlink(outside, join(linkedSrcPkg, "linked"), "dir");
    const viaSourceSymlink = await discoverPlugin(linkedSrcPkg, HOST);
    expect(viaSourceSymlink).toMatchObject({ ok: false, reasonCode: "MANIFEST_INVALID" });
    expect(probeCount()).toBe(0); // 且无部分注册：本层不存在注册通道
  });

  it.todo(
    "[PV0-A05] 缺要求不降级装 — REQUIREMENT_MISSING 判据已在 tests/plugin-manifest.test.ts 常驻；本题还要求 optional 缺失时 readiness 明列缺失 scope，readiness 投影未实现前不计绿（153/19F 裁定）",
  );

  it("[PV0-A06] manifest 无需执行代码", async () => {
    // 探针 entrypoint 顶层即抛错；非法 manifest 校验后探针计数为零 = import 从未发生。
    const broken = await discoverPlugin(await pkg('{"not": "valid manifest"'), HOST);
    expect(broken).toMatchObject({ ok: false, reasonCode: "MANIFEST_INVALID" });
    const missing = await discoverPlugin(await pkg(undefined), HOST);
    expect(missing).toMatchObject({ ok: false, reasonCode: "MANIFEST_INVALID" });
    expect(probeCount()).toBe(0);
  });

  it("[PV0-A07] 停用是真卸载", async () => {
    const store = new PluginOperationStore(join(root, `store-a07-${seq++}`));
    const host = new PluginTransactionHost({ store, newOperationId: () => `op-${seq++}` });
    const calls: string[] = [];
    const module: PluginModuleV0 = {
      async prepare(context) {
        calls.push("prepare");
        context.register({
          id: "res-1",
          kind: "tool",
          recoveryKey: "rk-1",
          async activate() {
            calls.push("resource.activate");
          },
          async dispose() {
            calls.push("resource.dispose");
          },
        });
        const prepared: PreparedPlugin = {
          async activate() {
            calls.push("publish");
            return {
              async dispose() {
                calls.push("plugin.dispose");
                return { revoked: ["res-1"], failed: [] };
              },
            };
          },
          async rollback() {
            calls.push("rollback");
          },
        };
        return prepared;
      },
    };
    const request = {
      pluginId: "demo.toggle",
      moduleRef: moduleRefFromSource("demo-toggle-v1"),
      module,
      config: { keep: "my-settings" },
      env: {},
      bindings: {},
      verifiedScope: {},
    };
    const on = await host.activate(request);
    expect(on.state).toBe("active");
    expect(host.publishedResources("demo.toggle")).toHaveLength(1);

    // enabled true→false：完整经过 dispose——能力与资源不可达，设置仍在
    const off = await host.dispose("demo.toggle");
    expect(off.state).toBe("disposed");
    expect(host.publishedResources("demo.toggle")).toEqual([]);
    const parked = store.read("demo.toggle");
    expect(parked.config).toEqual({ keep: "my-settings" });
    expect(calls).toContain("resource.dispose");
    expect(calls).toContain("plugin.dispose");

    // 重新启用：重新走完整注册事务，不复用旧 handle（prepare/activate 计数再涨）
    const before = calls.length;
    const on2 = await host.activate(request);
    expect(on2.state).toBe("active");
    const rerun = calls.slice(before);
    expect(rerun).toEqual(["prepare", "resource.activate", "publish"]);
    expect(host.publishedResources("demo.toggle")).toHaveLength(1);
  });

  it("[PV0-A08] plugin id 封口", async () => {
    for (const bad of ["Demo", "de mo", "de/mo", "../evil"]) {
      const r = await discoverPlugin(await pkg(manifestOf({ id: bad })), HOST);
      expect(r).toMatchObject({ ok: false, reasonCode: "MANIFEST_INVALID" });
    }
    const conflicted = await discoverPlugin(await pkg(manifestOf({ id: "already.active" })), {
      hostVersion: HOST.hostVersion,
      activeIds: new Set(["already.active"]),
    });
    expect(conflicted).toMatchObject({ ok: false, reasonCode: "PLUGIN_ID_CONFLICT" });
    expect(probeCount()).toBe(0); // 不加载代码
  });

  it("[PV0-A09] env 绑定形状不可混用", async () => {
    const dir = await pkg(
      manifestOf({
        env: [
          { name: "PLAIN", description: "", required: true, secret: false },
          { name: "SECRET", description: "", required: true, secret: true },
        ],
      }),
    );
    const discovered = await discoverPlugin(dir, HOST);
    expect(discovered.ok).toBe(true);
    if (!discovered.ok) return;
    const base = { enabled: true, settings: {}, credentialRefs: {} };

    const good = checkInstanceConfig(discovered.manifest, {
      ...base,
      environment: [
        { name: "PLAIN", value: "x" },
        { name: "SECRET", secretRef: "vault:s" },
      ],
    });
    expect(good.ok).toBe(true); // secret×secretRef 与 plain×value：唯二合法组合

    const secretByValue = checkInstanceConfig(discovered.manifest, {
      ...base,
      environment: [
        { name: "PLAIN", value: "x" },
        { name: "SECRET", value: "SECRET_SHOULD_NEVER_APPEAR" },
      ],
    });
    expect(secretByValue).toMatchObject({ ok: false, reasonCode: "CONFIG_INVALID" });

    const plainByRef = checkInstanceConfig(discovered.manifest, {
      ...base,
      environment: [
        { name: "PLAIN", secretRef: "vault:p" },
        { name: "SECRET", secretRef: "vault:s" },
      ],
    });
    expect(plainByRef).toMatchObject({ ok: false, reasonCode: "CONFIG_INVALID" });
    // 明文 secret 不进入配置快照：判定层直接拒绝，本层不产生任何快照。
  });

  it("[PV0-A10] env 只经 context 交付", async () => {
    const manifest = (
      (await discoverPlugin(
        await pkg(
          manifestOf({
            id: "demo.envonly",
            env: [
              { name: "A", description: "", required: true, secret: false },
              { name: "B", description: "", required: true, secret: true },
              { name: "C", description: "", required: false, secret: false },
            ],
          }),
        ),
        HOST,
      )) as { ok: true; manifest: import("../../src/plugin/manifest.ts").PluginManifestV0 }
    ).manifest;

    const goodConfig = {
      enabled: true,
      settings: {},
      environment: [
        { name: "A", value: "plain-a" },
        { name: "B", secretRef: "vault:b" },
      ],
      credentialRefs: {},
    };
    const assembled = resolveEnvironment(manifest, goodConfig, () => "SECRET_SHOULD_NEVER_APPEAR");
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;

    process.env.D = "process-env-probe";
    const store = new PluginOperationStore(join(root, `store-a10-${seq++}`));
    const host = new PluginTransactionHost({ store, newOperationId: () => `op-${seq++}` });
    let seenKeys: string[] = [];
    let seenB = "";
    const module: PluginModuleV0 = {
      async prepare(context) {
        seenKeys = Object.keys(context.env).sort();
        seenB = context.env.B ?? "";
        return {
          async activate() {
            return {
              async dispose() {
                return { revoked: [], failed: [] };
              },
            };
          },
          async rollback() {},
        };
      },
    };
    const outcome = await host.activate({
      pluginId: "demo.envonly",
      moduleRef: moduleRefFromSource("demo-envonly-v1"),
      module,
      config: { settingsOnly: true },
      env: assembled.env,
      bindings: { environment: goodConfig.environment },
      verifiedScope: {},
    });
    expect(outcome.state).toBe("active");
    // context.env 恰为 {A, B}（B 为已解析值）不含 C/D
    expect(seenKeys).toEqual(["A", "B"]);
    expect(seenB).toBe("SECRET_SHOULD_NEVER_APPEAR");
    expect(assembled.env).not.toHaveProperty("C");
    expect(assembled.env).not.toHaveProperty("D");
    // 配置快照（磁盘权威文件）中 B 的解析值不出现
    const snapshot = readFileSync(store.pathFor("demo.envonly"), "utf8");
    expect(snapshot).not.toContain("SECRET_SHOULD_NEVER_APPEAR");
    // 漏交 required：REQUIREMENT_MISSING
    const missingRequired = resolveEnvironment(
      manifest,
      { ...goodConfig, environment: [{ name: "A", value: "plain-a" }] },
      () => "x",
    );
    expect(missingRequired).toMatchObject({ ok: false, reasonCode: "REQUIREMENT_MISSING" });
    Reflect.deleteProperty(process.env, "D");
  });
});
