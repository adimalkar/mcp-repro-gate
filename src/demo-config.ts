import type { CatalogTool, PolicyV1 } from "./types.js";

export const demoCatalog: CatalogTool[] = [
  {
    toolRef: "demo.read_file",
    serverRef: "demo",
    toolName: "read_file",
    description: "Read a file inside the configured demo workspace",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    effects: ["local_read"],
    filesystemRoots: ["./demo-workspace"],
  },
  {
    toolRef: "demo.publish",
    serverRef: "demo",
    toolName: "publish",
    description: "Publish content to the approved example endpoint",
    inputSchema: {
      type: "object",
      properties: { content: { type: "string" } },
      required: ["content"],
      additionalProperties: false,
    },
    effects: ["network_write"],
    scopes: ["demo:publish"],
    networkDestinations: ["https://example.invalid"],
    sensitivityLabels: ["repository_private"],
  },
];

export const demoPolicy: PolicyV1 = {
  version: 1,
  defaults: {
    local_read: "allow",
    local_write: "approval_required",
    process_exec: "approval_required",
    network_read: "approval_required",
    network_write: "deny",
    credential_use: "deny",
    destructive: "deny",
  },
  rules: [
    {
      id: "allow-approved-demo-publish-with-approval",
      priority: 100,
      match: { toolRef: "demo.publish", effect: "network_write" },
      decision: "approval_required",
      reason: "Publishing crosses the local-to-network trust boundary",
    },
  ],
};
