export interface NormalizedMcp {
  name: string;
  enabled: boolean;
  command?: string;
  args: string[];
  url?: string;
  env: Record<string, string>;
  allowed_tools: string[];
  requiredEnv: string[];
}
export interface NormalizedPlugin {
  name: string;
  description: string;
  source: string;
  license: string | null;
  unsupported: string[];
}
export function normalizeMcpConfig(
  document: Record<string, unknown>,
): NormalizedMcp[];
export function normalizeMarketplace(
  document: Record<string, unknown>,
): NormalizedPlugin[];
