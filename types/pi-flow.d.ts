import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface FlowExtensionOptions {
  maxConcurrentSubagents?: number;
  subagentTimeoutMs?: number;
  workflow?: boolean;
}

export function createFlowExtension(options?: FlowExtensionOptions): (pi: ExtensionAPI) => void;
