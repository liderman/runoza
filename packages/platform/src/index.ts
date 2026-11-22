export interface PlatformAdapter {
  readPreference(key: string): string | null;
  writePreference(key: string, value: string): void;
  navigate(url: string): void;
  setLanguage(lang: "en" | "ru"): void;
  preferredLanguage: string;
}

export type { DesktopBridge, DesktopFolder } from "./desktop.ts";
