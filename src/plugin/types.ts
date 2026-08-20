/**
 * Plugin Protocol v0 — canonical host-side types.
 *
 * Source of truth: docs/design/plugin-protocol-v0.md (§2 manifest, §3 transactions,
 * §8 stable failure semantics). These six interfaces are the authoritative versions
 * of the consumer-side copies in webui/mist-plugin.ts (#61) and are shape-compatible
 * with them by construction; the webui copy re-points here in a follow-up PR.
 *
 * Scope note (#76 单B PR①): types and lifecycle skeleton only — no runtime semantics.
 * Everything fenced as `@provisional` tracks the #62 candidate (recovery descriptors,
 * operation ids) and is to be reconciled verbatim with the merged wording of #62.
 */

/** A single capability-backed resource a plugin asks the host to register. RFC §3. */
export interface ResourceDeclaration {
  readonly id: string;
  readonly kind: "route" | "tool" | "listener" | "timer" | "connection";
  readonly capabilityId?: string;
  activate(): Promise<void>;
  dispose(): Promise<void>;
}

/** Host receipt for one registered resource; revocation is the host's lever. RFC §3. */
export interface DisposableHandle {
  readonly id: string;
  revoke(): Promise<void>;
}

/** What a plugin sees during prepare: identity, validated config, and a registrar. RFC §3. */
export interface PluginPrepareContext {
  readonly pluginId: string;
  readonly config: unknown;
  register(resource: ResourceDeclaration): DisposableHandle;
}

/** Terminal dispose accounting. Only an empty `failed` array is a clean unload (PV0-C07). */
export interface DisposeReport {
  readonly revoked: readonly string[];
  readonly failed: readonly { id: string; reasonCode: ReasonCode }[];
}

/** An activated plugin. Callers MUST inspect `failed[]` on dispose. RFC §3. */
export interface ActivePlugin {
  dispose(): Promise<DisposeReport>;
}

/** A prepared-but-unpublished plugin: activate commits, rollback reverses. RFC §3. */
export interface PreparedPlugin {
  activate(): Promise<ActivePlugin>;
  rollback(): Promise<void>;
}

/**
 * Stable failure reason codes, verbatim from RFC §8. Details may be appended to an
 * error, but never substituted for the code.
 */
export type ReasonCode =
  | "MANIFEST_INVALID"
  | "HOST_INCOMPATIBLE"
  | "PLUGIN_ID_CONFLICT"
  | "CONFIG_INVALID"
  | "REQUIREMENT_MISSING"
  | "CREDENTIAL_TYPE_MISMATCH"
  | "CREDENTIAL_ISSUER_UNAVAILABLE"
  | "PERMISSION_DENIED"
  | "PREPARE_FAILED"
  | "ACTIVATE_FAILED"
  | "MIGRATION_FAILED"
  | "UPGRADE_PERMISSION_CONFIRMATION_REQUIRED"
  | "DISPOSE_INCOMPLETE"
  | "LIFECYCLE_RECOVERY_PENDING"
  | "PLUGIN_RUNTIME_FAILED"
  | "CONTEXT_INJECTION_MISMATCH"
  | "SENSITIVE_OUTPUT_BLOCKED"
  | "CAPABILITY_UNVERIFIED";

/**
 * @provisional Pending #62 merge — reconcile names and shapes verbatim with the merged
 * wording before any implementation lands (单B ②段 owns the semantics; these exist only
 * so the type surface has a named seam). Do not implement against these yet.
 */
export type OperationId = string;

/** @provisional See {@link OperationId} note. Identifies a revocable side effect across restarts. */
export type RecoveryKey = string;

/**
 * @provisional #62 candidate: what a crashed-and-restarted host gets back for coordination —
 * in-memory handles died with the old process, so recovery works from persisted descriptors.
 * Shape TBD by merged #62; interface reserved as an import seam for ②段.
 */
export interface RecoveredPlugin {
  readonly pluginId: string;
  readonly operationId: OperationId;
}
