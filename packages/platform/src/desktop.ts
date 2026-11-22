export interface DesktopFolder {
  id: string;
  deviceId: string;
  name: string;
  path: string;
}
export interface DesktopBridge {
  readonly platform?: string;
  status(): Promise<{
    deviceId?: string;
    server: string;
    code?: string;
    platform?: string;
  }>;
  connect(server: string): Promise<unknown>;
  localExtensions(): Promise<{
    skills: {
      id: string;
      name: string;
      description: string;
      scope: string;
      workspaceId?: string;
      path: string;
      digest: string;
      fileCount: number;
    }[];
    mcp: {
      id: string;
      name: string;
      scope: string;
      transport: "http" | "stdio";
      command?: string[];
      endpoint?: string;
      allowedTools: string[];
      envRefs: Record<string, string>;
      enabled: boolean;
      cwd: string;
      source: string;
    }[];
    errors: { source: string; code: string }[];
  }>;
  readLocalSkill(id: string): Promise<{ path: string; base64: string }[]>;
  chooseFolder(): Promise<DesktopFolder | null>;
}
declare global {
  interface Window {
    runozaDesktop?: DesktopBridge;
  }
}
