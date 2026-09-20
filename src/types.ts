export type Digest = `sha256:${string}`;

export type Decision = "allow" | "approval_required" | "deny";

export type EffectClass =
  | "local_read"
  | "local_write"
  | "process_exec"
  | "network_read"
  | "network_write"
  | "credential_use"
  | "destructive";

export interface Principal {
  host: string;
  clientVersion?: string;
  subject?: string;
  source: "transport_verified" | "client_asserted" | "unknown";
}

export interface ObservedWorkspace {
  source: "gateway_observed";
  rootDigest: Digest;
  commit?: string;
  treeDigest?: Digest;
  dirtyDiffDigest?: Digest;
}

export interface ActionEnvelopeV1 {
  envelopeVersion: 1;
  actionId: Digest;
  runId: string;
  principal: Principal;
  tool: {
    serverRef: string;
    toolName: string;
    schemaDigest: Digest;
    trustSource: "operator_catalog";
    artifactDigest?: Digest;
  };
  input: {
    argumentsDigest: Digest;
    sensitivityLabels: string[];
  };
  authority: {
    policyDigest: Digest;
    effects: EffectClass[];
    scopes: string[];
    filesystemRoots: string[];
    networkDestinations: string[];
    secretHandles: string[];
  };
  observedWorkspace?: ObservedWorkspace;
  plannedAt: string;
  expiresAt: string;
}

export type UnsignedActionEnvelopeV1 = Omit<ActionEnvelopeV1, "actionId">;

export interface PolicyRule {
  id: string;
  priority: number;
  match: {
    toolRef?: string;
    effect?: EffectClass;
  };
  decision: Decision;
  reason: string;
}

export interface PolicyV1 {
  version: 1;
  defaults: Record<EffectClass, Decision>;
  rules: PolicyRule[];
}

export interface PolicyDecision {
  decision: Decision;
  policyDigest: Digest;
  reasons: {
    effect: EffectClass;
    decision: Decision;
    ruleId: string;
    reason: string;
  }[];
}

export interface CatalogTool {
  toolRef: string;
  serverRef: string;
  toolName: string;
  description: string;
  inputSchema: unknown;
  effects: EffectClass[];
  scopes?: string[];
  filesystemRoots?: string[];
  networkDestinations?: string[];
  secretHandles?: string[];
  sensitivityLabels?: string[];
  artifactDigest?: Digest;
}
