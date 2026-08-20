/** PV0 acceptance suite — series C: 事务注册、隔离与注销 (RFC §3/§4). */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { moduleRefFromSource } from "../../src/plugin/module-ref.ts";
import {
  type PluginAuthorityRecord,
  type PluginOperationResourceRecord,
  PluginOperationStore,
} from "../../src/plugin/operation-store.ts";
import {
  PluginTransactionHost,
  type RecoveryModule,
  type RecoveryModuleLoader,
} from "../../src/plugin/transaction-host.ts";
import type {
  ActivePlugin,
  DisposeReport,
  PluginModuleV0,
  PluginPrepareContext,
  PreparedPlugin,
  RecoveredPlugin,
  RecoveryResourceRecord,
  ResourceDeclaration,
} from "../../src/plugin/types.ts";
import {
  cleanupProcessHarness,
  collectChild,
  freshProcessDirectory,
  killChildAt,
  processCalls,
  processEffects,
  processOperationRecord,
  startPluginHostChild,
} from "./pv0-c-process-harness.ts";

const storeDirectories: string[] = [];
const moduleRef = moduleRefFromSource("PV0-C in-process fixture v1");
const resourceIds = ["route-a", "tool-b", "timer-c"] as const;
const authority = {
  config: { enabled: true, declarationVersion: "fixture-v1" },
  bindings: [{ residentId: "resident-fixture", lane: "primary" }],
  verifiedScope: { residentId: "resident-fixture", operations: ["call"] },
};

interface FixtureControls {
  readonly failResourceActivate: Set<string>;
  readonly failResourceDispose: Set<string>;
  readonly failRecoveredRevoke: Set<string>;
  failPreparedActivate: boolean;
}

interface FixtureState {
  readonly calls: string[];
  readonly committed: Set<string>;
  readonly reachable: Set<string>;
  readonly controls: FixtureControls;
  module: PluginModuleV0;
}

function freshStore(): PluginOperationStore {
  const directory = mkdtempSync(join(tmpdir(), "mist-pv0-c-store-"));
  storeDirectories.push(directory);
  return new PluginOperationStore(directory);
}

function fixture(): FixtureState {
  const calls: string[] = [];
  const committed = new Set<string>();
  const reachable = new Set<string>();
  const controls: FixtureControls = {
    failResourceActivate: new Set(),
    failResourceDispose: new Set(),
    failRecoveredRevoke: new Set(),
    failPreparedActivate: false,
  };
  const module: PluginModuleV0 = {
    async prepare(context) {
      calls.push("prepare");
      for (const id of resourceIds) context.register(declaration(id));
      return preparedPlugin();
    },
    async recover() {
      calls.push("recover");
      const recovered: RecoveredPlugin = {
        async revoke(resource: RecoveryResourceRecord) {
          calls.push(`recovered.revoke:${resource.id}`);
          if (controls.failRecoveredRevoke.has(resource.id)) {
            throw new Error(`recovered revoke failed: ${resource.id}`);
          }
          committed.delete(resource.id);
        },
        async rollback() {
          calls.push("recovered.rollback");
          reachable.clear();
        },
        async dispose(): Promise<DisposeReport> {
          calls.push("recovered.dispose");
          reachable.clear();
          return { revoked: [], failed: [] };
        },
      };
      return recovered;
    },
  };

  function declaration(id: string): ResourceDeclaration {
    return {
      id,
      kind: id.startsWith("route") ? "route" : id.startsWith("timer") ? "timer" : "tool",
      recoveryKey: `recover:${id}`,
      async activate() {
        calls.push(`resource.activate:${id}`);
        if (controls.failResourceActivate.has(id)) {
          throw new Error(`resource activate failed: ${id}`);
        }
        committed.add(id);
      },
      async dispose() {
        calls.push(`resource.dispose:${id}`);
        if (controls.failResourceDispose.has(id)) {
          throw new Error(`resource dispose failed: ${id}`);
        }
        committed.delete(id);
      },
    };
  }

  function preparedPlugin(): PreparedPlugin {
    return {
      async activate(): Promise<ActivePlugin> {
        calls.push("prepared.activate");
        if (controls.failPreparedActivate) throw new Error("publication failed");
        for (const id of resourceIds) reachable.add(id);
        return {
          async dispose(): Promise<DisposeReport> {
            calls.push("active.dispose");
            reachable.clear();
            return { revoked: [], failed: [] };
          },
        };
      },
      async rollback() {
        calls.push("prepared.rollback");
        reachable.clear();
      },
    };
  }

  return { calls, committed, reachable, controls, module };
}

function activate(host: PluginTransactionHost, module: PluginModuleV0) {
  return host.activate({
    pluginId: "fixture.plugin",
    moduleRef,
    module,
    env: {},
    ...authority,
  });
}

function loader(state: FixtureState): RecoveryModuleLoader {
  return async () => ({
    module: state.module,
    moduleRef,
    env: {},
    recoveryKeys: Object.fromEntries(resourceIds.map((id) => [id, `recover:${id}`])),
  });
}

afterEach(async () => {
  await cleanupProcessHarness();
  for (const directory of storeDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("PV0 series C — 事务注册、隔离与注销 (RFC §3/§4)", () => {
  it("[PV0-C01] prepare 不提前公开", async () => {
    const store = freshStore();
    let releasePrepare: (() => void) | undefined;
    let registered: (() => void) | undefined;
    const allRegistered = new Promise<void>((resolve) => {
      registered = resolve;
    });
    const prepareGate = new Promise<void>((resolve) => {
      releasePrepare = resolve;
    });
    const state = fixture();
    const originalPrepare = state.module.prepare;
    state.module = {
      ...state.module,
      async prepare(context) {
        const prepared = await originalPrepare(context);
        registered?.();
        await prepareGate;
        return prepared;
      },
    };
    const host = new PluginTransactionHost({ store });

    const activation = activate(host, state.module);
    await allRegistered;
    expect(store.read("fixture.plugin").operation.resources).toHaveLength(3);
    expect(state.committed).toEqual(new Set());
    expect(state.reachable).toEqual(new Set());
    expect(host.publishedResources("fixture.plugin")).toEqual([]);
    releasePrepare?.();
    await expect(activation).resolves.toMatchObject({ state: "active" });
  });

  it("[PV0-C02] 部分注册失败全回滚", async () => {
    const store = freshStore();
    const revoked: string[] = [];
    const declaration = (id: string): ResourceDeclaration => ({
      id,
      kind: "tool",
      recoveryKey: `recover:${id}`,
      async activate() {},
      async dispose() {
        revoked.push(id);
      },
    });
    const module: PluginModuleV0 = {
      async prepare(context: PluginPrepareContext) {
        context.register(declaration("first"));
        context.register(declaration("second"));
        context.register(declaration("first"));
        throw new Error("unreachable");
      },
    };
    const host = new PluginTransactionHost({ store });

    await expect(activate(host, module)).resolves.toMatchObject({
      state: "blocked",
      reasonCode: "PREPARE_FAILED",
    });
    expect(revoked).toEqual(["second", "first"]);
    expect(host.publishedResources("fixture.plugin")).toEqual([]);
    expect(store.read("fixture.plugin").operation.resources.map((entry) => entry.phase)).toEqual([
      "revoked",
      "revoked",
    ]);
  });

  it("[PV0-C03] activate 失败全回滚", async () => {
    const store = freshStore();
    const state = fixture();
    state.controls.failPreparedActivate = true;
    const host = new PluginTransactionHost({ store });

    await expect(activate(host, state.module)).resolves.toMatchObject({
      state: "blocked",
      reasonCode: "ACTIVATE_FAILED",
    });
    expect(state.calls.slice(-4)).toEqual([
      "resource.dispose:timer-c",
      "resource.dispose:tool-b",
      "resource.dispose:route-a",
      "prepared.rollback",
    ]);
    expect(state.committed).toEqual(new Set());
    expect(state.reachable).toEqual(new Set());
    expect(host.publishedResources("fixture.plugin")).toEqual([]);
  });

  it("[PV0-C04] 成功提交原子可见", async () => {
    const store = freshStore();
    const state = fixture();
    const projections: string[][] = [];
    const host = new PluginTransactionHost({
      store,
      checkpoint: async () => {
        projections.push(host.publishedResources("fixture.plugin").map((entry) => entry.id));
      },
    });

    await expect(activate(host, state.module)).resolves.toMatchObject({ state: "active" });
    expect(projections.every((projection) => projection.length === 0)).toBe(true);
    expect(host.publishedResources("fixture.plugin").map((entry) => entry.id)).toEqual(resourceIds);
    expect(state.reachable).toEqual(new Set(resourceIds));
  });

  it("[PV0-C05] dispose 幂等", async () => {
    const store = freshStore();
    const state = fixture();
    let sequence = 0;
    const host = new PluginTransactionHost({
      store,
      newOperationId: () => `operation-${String(++sequence)}`,
    });
    await activate(host, state.module);

    const first = await host.dispose("fixture.plugin");
    const callsAfterFirst = [...state.calls];
    const second = await host.dispose("fixture.plugin");

    expect(first).toEqual(second);
    expect(first.state).toBe("disposed");
    expect(state.calls).toEqual(callsAfterFirst);
    expect(state.calls.filter((call) => call.startsWith("resource.dispose:"))).toEqual([
      "resource.dispose:timer-c",
      "resource.dispose:tool-b",
      "resource.dispose:route-a",
    ]);
    expect(host.publishedResources("fixture.plugin")).toEqual([]);
  });

  // STUBBED-PENDING: the frozen host has no call dispatcher/in-flight registry yet.
  it.todo("[PV0-C06] 注销先断路");

  it("[PV0-C07] 清理失败 fail-closed", async () => {
    const store = freshStore();
    const state = fixture();
    state.controls.failResourceDispose.add("tool-b");
    const host = new PluginTransactionHost({ store });
    await activate(host, state.module);

    await expect(host.dispose("fixture.plugin")).resolves.toMatchObject({
      state: "quarantined",
      reasonCode: "DISPOSE_INCOMPLETE",
      remainingResourceIds: ["tool-b"],
    });
    expect(host.publishedResources("fixture.plugin")).toEqual([]);
    expect(store.read("fixture.plugin").quarantine).toMatchObject({
      reasonCode: "DISPOSE_INCOMPLETE",
      remainingResourceIds: ["tool-b"],
    });
  });

  // STUBBED-PENDING: runtime call isolation/timeout belongs to the absent dispatcher layer.
  it.todo("[PV0-C08] 单插件故障不拖地基");
  // STUBBED-PENDING: there is no production call scheduler whose retry policy can be observed.
  it.todo("[PV0-C09] 不自动重试风暴");

  it("[PV0-C10] 生命周期中断可恢复", async () => {
    const activationDir = freshProcessDirectory();
    const activationChild = startPluginHostChild(activationDir, "activate", {
      stopAt: "resource-effect-before-receipt",
    });
    await killChildAt(activationChild, "resource-effect-before-receipt");
    const activationRecord = processOperationRecord(activationDir);
    expect(activationRecord.operation.operationId).toBe("fixture-operation-1");
    expect(activationRecord.moduleRef).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(activationRecord.operation.resources.map((entry) => entry.recoveryKey)).toEqual([
      "recover:route-a",
      "recover:tool-b",
      "recover:tool-c",
    ]);
    expect(processEffects(activationDir)).toContain("route-a.live");
    const activationCallCount = processCalls(activationDir).length;
    const activationRecovered = await collectChild(startPluginHostChild(activationDir, "recover"));
    expect(activationRecovered.outcomes[0]).toMatchObject({
      state: "blocked",
      reasonCode: "ACTIVATE_FAILED",
      operationId: "fixture-operation-1",
    });
    expect(activationRecovered.authority).toMatchObject({
      enabled: true,
      config: authority.config,
      bindings: authority.bindings,
    });
    expect(activationRecovered.published).toEqual([]);
    expect(processEffects(activationDir)).toEqual([]);
    expect(processCalls(activationDir).slice(activationCallCount)).toEqual([
      "recover",
      "recovered.revoke:tool-c",
      "recovered.revoke:tool-b",
      "recovered.revoke:route-a",
      "recovered.rollback",
    ]);

    const publishDir = freshProcessDirectory();
    const publishChild = startPluginHostChild(publishDir, "activate", { blockPublish: true });
    await killChildAt(publishChild, "plugin-publish-entered");
    expect(processOperationRecord(publishDir).operation.phase).toBe("authority_committed");
    expect(processEffects(publishDir)).toEqual([
      "published.live",
      "route-a.live",
      "tool-b.live",
      "tool-c.live",
    ]);
    const publishCallCount = processCalls(publishDir).length;
    const publishRecovered = await collectChild(startPluginHostChild(publishDir, "recover"));
    expect(publishRecovered.outcomes[0]).toMatchObject({
      state: "blocked",
      reasonCode: "ACTIVATE_FAILED",
    });
    expect(publishRecovered.published).toEqual([]);
    expect(processEffects(publishDir)).toEqual([]);
    expect(processCalls(publishDir).slice(publishCallCount)).toEqual([
      "recover",
      "recovered.revoke:tool-c",
      "recovered.revoke:tool-b",
      "recovered.revoke:route-a",
      "recovered.rollback",
    ]);

    const disposeDir = freshProcessDirectory();
    const disposeChild = startPluginHostChild(disposeDir, "activate-dispose", {
      stopAt: "dispose-resource-effect-before-receipt",
    });
    await killChildAt(disposeChild, "dispose-resource-effect-before-receipt");
    expect(processOperationRecord(disposeDir).operation.operation).toBe("dispose");
    const disposeRecovered = await collectChild(startPluginHostChild(disposeDir, "recover"));
    expect(disposeRecovered.authority.lifecycleState).toBe("disposed");
    expect(disposeRecovered.authority.operation.disposeCompleted).toBe(true);
    expect(disposeRecovered.published).toEqual([]);
    expect(processEffects(disposeDir)).toEqual([]);

    const resource = (
      registrationIndex: number,
      id: string,
      recoveryKey: string | null,
    ): PluginOperationResourceRecord => ({
      registrationIndex,
      id,
      kind: "tool",
      recoveryKey,
      phase: "ready",
    });
    const interruptedRecord = (
      resources: readonly PluginOperationResourceRecord[],
    ): PluginAuthorityRecord => ({
      schemaVersion: 1,
      pluginId: "fixture.plugin",
      lifecycleState: "prepared",
      enabled: true,
      moduleRef,
      ...authority,
      operation: {
        operationId: "operation-interrupted",
        operation: "activate",
        phase: "activating",
        moduleRef,
        resources: [...resources],
        rollbackCompleted: false,
        disposeCompleted: false,
        cleanupAttempts: [],
      },
    });
    const invalidCases: readonly {
      readonly name: string;
      readonly resources: readonly PluginOperationResourceRecord[];
      readonly recoveryKeys?: Readonly<Record<string, string>>;
    }[] = [
      {
        name: "missing recovery key",
        resources: [resource(0, "tool-a", null)],
      },
      {
        name: "duplicate recovery key",
        resources: [
          resource(0, "tool-a", "recover:shared"),
          resource(1, "tool-b", "recover:shared"),
        ],
      },
      {
        name: "drifting recovery key",
        resources: [resource(0, "tool-a", "recover:logged")],
        recoveryKeys: { "tool-a": "recover:actual" },
      },
    ];
    for (const invalidCase of invalidCases) {
      const invalidStore = freshStore();
      invalidStore.save(interruptedRecord(invalidCase.resources));
      let recoverCalls = 0;
      const recoveryModule: PluginModuleV0 = {
        async prepare() {
          throw new Error("startup recovery must not prepare");
        },
        async recover() {
          recoverCalls += 1;
          throw new Error("invalid descriptors must be rejected before recover");
        },
      };
      const [outcome] = await new PluginTransactionHost({ store: invalidStore }).coordinateStartup(
        async () => ({
          module: recoveryModule,
          moduleRef,
          env: {},
          ...(invalidCase.recoveryKeys === undefined
            ? {}
            : { recoveryKeys: invalidCase.recoveryKeys }),
        }),
      );
      expect(outcome, invalidCase.name).toMatchObject({
        state: "quarantined",
        reasonCode: "RECOVERY_HANDLE_UNAVAILABLE",
      });
      expect(recoverCalls, invalidCase.name).toBe(0);
      expect(invalidStore.read("fixture.plugin").quarantine).toMatchObject({
        remainingResourceIds: invalidCase.resources.map((entry) => entry.id),
      });
      await expect(
        new PluginTransactionHost({ store: invalidStore }).coordinateStartup(async () => {
          throw new Error("quarantined record must not be retried automatically");
        }),
      ).resolves.toEqual([]);
    }

    const failureCases = ["module drift", "recover throws"] as const;
    for (const failureCase of failureCases) {
      const failureStore = freshStore();
      failureStore.save(interruptedRecord([resource(0, "tool-a", "recover:tool-a")]));
      let recoverCalls = 0;
      const recoveryModule: PluginModuleV0 = {
        async prepare() {
          throw new Error("startup recovery must not prepare");
        },
        async recover() {
          recoverCalls += 1;
          throw new Error("fixture recover failure");
        },
      };
      const [outcome] = await new PluginTransactionHost({ store: failureStore }).coordinateStartup(
        async () => ({
          module: recoveryModule,
          moduleRef:
            failureCase === "module drift"
              ? moduleRefFromSource("PV0-C changed module")
              : moduleRef,
          env: {},
          recoveryKeys: { "tool-a": "recover:tool-a" },
        }),
      );
      expect(outcome, failureCase).toMatchObject({
        state: "quarantined",
        reasonCode: "RECOVERY_HANDLE_UNAVAILABLE",
        remainingResourceIds: ["tool-a"],
      });
      expect(recoverCalls, failureCase).toBe(failureCase === "recover throws" ? 1 : 0);
      expect(failureStore.read("fixture.plugin").quarantine?.manualActions).not.toEqual([]);
    }

    const pendingStore = freshStore();
    pendingStore.save(interruptedRecord([resource(0, "tool-a", "recover:tool-a")]));
    const pendingHost = new PluginTransactionHost({ store: pendingStore });
    let releaseLoader: ((loaded: RecoveryModule) => void) | undefined;
    const unresolvedLoader = new Promise<RecoveryModule>((resolve) => {
      releaseLoader = resolve;
    });
    const coordination = pendingHost.coordinateStartup(async () => unresolvedLoader);
    expect(pendingHost.status("fixture.plugin")).toMatchObject({
      state: "blocked",
      reasonCode: "LIFECYCLE_RECOVERY_PENDING",
    });
    const recoveredModule: PluginModuleV0 = {
      async prepare() {
        throw new Error("startup recovery must not prepare");
      },
      async recover() {
        return {
          async revoke() {},
          async rollback() {},
          async dispose() {
            return { revoked: [], failed: [] };
          },
        };
      },
    };
    releaseLoader?.({
      module: recoveredModule,
      moduleRef,
      env: {},
      recoveryKeys: { "tool-a": "recover:tool-a" },
    });
    await expect(coordination).resolves.toEqual([
      expect.objectContaining({ state: "blocked", reasonCode: "ACTIVATE_FAILED" }),
    ]);
  }, 30_000);

  it("[PV0-C11] 权威状态先于公开索引", async () => {
    const checkpoints = [
      "before-active-authority-commit",
      "active-authority-committed-before-publish",
      "published-before-operation-complete",
    ] as const;
    for (const checkpoint of checkpoints) {
      const dataDir = freshProcessDirectory();
      const child = startPluginHostChild(dataDir, "activate", { stopAt: checkpoint });
      await killChildAt(child, checkpoint);
      const interrupted = processOperationRecord(dataDir);
      expect(interrupted.lifecycleState).toBe(
        checkpoint === "before-active-authority-commit" ? "prepared" : "active",
      );
      const recovered = await collectChild(startPluginHostChild(dataDir, "recover"));
      expect(recovered.published).toEqual([]);
      expect(recovered.authority.lifecycleState).toBe("blocked");
      expect(processEffects(dataDir)).toEqual([]);
    }
  }, 30_000);

  it("[PV0-C12] quarantined 只能显式清理重试", async () => {
    const store = freshStore();
    const state = fixture();
    state.controls.failResourceDispose.add("tool-b");
    state.controls.failRecoveredRevoke.add("tool-b");
    const host = new PluginTransactionHost({ store });
    await activate(host, state.module);
    const quarantined = await host.dispose("fixture.plugin");
    const callsAfterDispose = [...state.calls];

    expect(await host.dispose("fixture.plugin")).toEqual(quarantined);
    expect(state.calls).toEqual(callsAfterDispose);
    const failedRetry = await host.retryCleanup("fixture.plugin", loader(state));
    expect(failedRetry).toMatchObject({
      state: "quarantined",
      reasonCode: "RECOVERY_HANDLE_UNAVAILABLE",
      remainingResourceIds: ["tool-b"],
    });
    expect(store.read("fixture.plugin").operation.cleanupAttempts[0]).toMatchObject({
      failedResourceIds: ["tool-b"],
      reasonCode: "RECOVERY_HANDLE_UNAVAILABLE",
    });
    expect(store.read("fixture.plugin").quarantine?.manualActions.join(" ")).toContain("tool-b");

    state.controls.failRecoveredRevoke.clear();
    await expect(host.retryCleanup("fixture.plugin", loader(state))).resolves.toMatchObject({
      state: "disposed",
    });
    expect(host.publishedResources("fixture.plugin")).toEqual([]);
  });

  it("[PV0-C13] 两个 activate 顺序固定", async () => {
    const store = freshStore();
    const calls: string[] = [];
    const committed = new Set<string>();
    const module: PluginModuleV0 = {
      async prepare(context) {
        for (const id of resourceIds) {
          context.register({
            id,
            kind: "tool",
            recoveryKey: `recover:${id}`,
            async activate() {
              calls.push(`resource.activate:${id}`);
              committed.add(id);
            },
            async dispose() {
              calls.push(`resource.dispose:${id}`);
              committed.delete(id);
            },
          });
        }
        return {
          async activate() {
            calls.push("prepared.activate");
            expect(committed).toEqual(new Set(resourceIds));
            expect(host.publishedResources("fixture.plugin")).toEqual([]);
            expect(store.read("fixture.plugin")).toMatchObject({
              lifecycleState: "active",
              config: authority.config,
              bindings: authority.bindings,
              verifiedScope: authority.verifiedScope,
            });
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
    const host = new PluginTransactionHost({ store });
    await expect(activate(host, module)).resolves.toMatchObject({ state: "active" });
    expect(calls).toEqual([
      "resource.activate:route-a",
      "resource.activate:tool-b",
      "resource.activate:timer-c",
      "prepared.activate",
    ]);

    const failedState = fixture();
    failedState.controls.failResourceActivate.add("tool-b");
    const failedHost = new PluginTransactionHost({ store: freshStore() });
    await expect(activate(failedHost, failedState.module)).resolves.toMatchObject({
      state: "blocked",
      reasonCode: "ACTIVATE_FAILED",
    });
    expect(failedState.calls).not.toContain("prepared.activate");
    expect(failedHost.publishedResources("fixture.plugin")).toEqual([]);
  });

  it("[PV0-C14] 恢复凭据防模块漂移", async () => {
    const dataDir = freshProcessDirectory();
    const sourcePath = join(dataDir, "fixture-module.ts");
    const originalFixturePath = fileURLToPath(
      new URL("../fixtures/recoverable-plugin.ts", import.meta.url),
    );
    const originalFixtureSource = readFileSync(originalFixturePath, "utf8");
    const fixtureV1 = `${originalFixtureSource}\nexport const declarationVersion = "fixture-v1";\n`;
    writeFileSync(sourcePath, fixtureV1, "utf8");
    const expectedModuleRef = moduleRefFromSource(readFileSync(sourcePath));
    const child = startPluginHostChild(dataDir, "activate", {
      stopAt: "resource-effect-before-receipt",
      moduleSourcePath: sourcePath,
    });
    await killChildAt(child, "resource-effect-before-receipt");
    expect(processOperationRecord(dataDir).moduleRef).toBe(expectedModuleRef);
    const callsBeforeRecovery = processCalls(dataDir).length;

    writeFileSync(sourcePath, `${fixtureV1}\n// changed in place without a version bump\n`, "utf8");
    const actualModuleRef = moduleRefFromSource(readFileSync(sourcePath));
    expect(actualModuleRef).not.toBe(expectedModuleRef);
    const recovered = await collectChild(
      startPluginHostChild(dataDir, "recover", { moduleSourcePath: sourcePath }),
    );

    expect(recovered.outcomes[0]).toMatchObject({
      state: "quarantined",
      reasonCode: "RECOVERY_HANDLE_UNAVAILABLE",
    });
    expect(processCalls(dataDir).slice(callsBeforeRecovery)).toEqual([]);
    expect(recovered.authority.quarantine?.manualActions.join(" ")).toContain(expectedModuleRef);
    expect(recovered.authority.quarantine?.manualActions.join(" ")).toContain(actualModuleRef);
    const restarted = await collectChild(
      startPluginHostChild(dataDir, "recover", { moduleSourcePath: sourcePath }),
    );
    expect(restarted.outcomes).toEqual([]);
    expect(restarted.authority.quarantine?.manualActions).toEqual(
      recovered.authority.quarantine?.manualActions,
    );
  }, 20_000);
});
