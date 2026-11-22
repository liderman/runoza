import { createRoot } from "react-dom/client";
import { RunozaApp } from "@runoza/app";
import { createIdentityClient } from "@runoza/api-client";
import type { PlatformAdapter } from "@runoza/platform";
import "@gravity-ui/uikit/styles/styles.css";
import "@gravity-ui/aikit/themes/common";
import "@gravity-ui/aikit/themes/light";
import "@gravity-ui/aikit/themes/dark";
import "@runoza/ui/theme.css";
import "./style.css";
const platform: PlatformAdapter = {
  preferredLanguage: navigator.language,
  readPreference: (key) => localStorage.getItem("runoza." + key),
  writePreference: (key, value) => localStorage.setItem("runoza." + key, value),
  navigate: (url) => location.assign(url),
  setLanguage: (lang) => {
    document.documentElement.lang = lang;
  },
};
const initialError = new URL(location.href).searchParams.get("authError") ?? "";
if (initialError) history.replaceState(null, "", location.pathname);
createRoot(document.getElementById("root")!).render(
  <RunozaApp
    initialError={initialError}
    api={createIdentityClient(location.origin)}
    platform={platform}
  />,
);
