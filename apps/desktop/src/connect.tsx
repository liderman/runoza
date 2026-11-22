import type {} from "@runoza/platform";
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Provider,
  Flex,
  Text,
  TextInput,
  Button,
  Card,
  Alert,
  Loader,
} from "@gravity-ui/uikit";
import "@gravity-ui/uikit/styles/styles.css";
import "@runoza/ui/theme.css";
import "./connect.css";
import { BrandLogo } from "@runoza/ui";
function Connect() {
  const [url, setUrl] = useState("http://127.0.0.1:53009"),
    [code, setCode] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [dark, setDark] = useState(
      localStorage.getItem("connect-theme") !== "light",
    ),
    [ru, setRu] = useState(true);
  const s = (a: string, b: string) => (ru ? a : b);
  useEffect(() => {
    void window.runozaDesktop?.status().then((x) => setUrl(x.server));
    const timer = setInterval(
      () =>
        void window.runozaDesktop?.status().then((x) => setCode(x.code ?? "")),
      500,
    );
    return () => clearInterval(timer);
  }, []);
  return (
    <Provider theme={dark ? "dark" : "light"}>
      {window.runozaDesktop?.platform === "darwin" && (
        <div className="desktop-titlebar">Runóza</div>
      )}
      <Flex direction="column" gap="spacing-5" className="desktop-connect">
        <Flex justifyContent="space-between">
          <BrandLogo />
          <Flex gap="spacing-2">
            <Button view="flat" onClick={() => setRu(!ru)}>
              EN / RU
            </Button>
            <Button
              view="flat"
              onClick={() => (
                localStorage.setItem("connect-theme", dark ? "light" : "dark"),
                setDark(!dark)
              )}
            >
              {s("Сменить тему", "Switch theme")}
            </Button>
          </Flex>
        </Flex>
        <Card view="outlined" padding="spacing-6">
          <Flex direction="column" gap="spacing-4">
            <Text variant="header-1">
              {s("Подключиться к серверу", "Connect to a server")}
            </Text>
            <Text color="secondary">
              {s(
                "Беседы и модели остаются на вашем сервере. Для выполнения на компьютере выберите папку через «Работать в».",
                "Conversations and models stay on your server. Choose a folder under “Work in” to run commands on this computer.",
              )}
            </Text>
            <TextInput
              value={url}
              onUpdate={setUrl}
              disabled={busy}
              controlProps={{
                "aria-label": s("Адрес сервера", "Server address"),
              }}
            />
            <Button
              view="action"
              loading={busy}
              disabled={!url}
              onClick={() => {
                setBusy(true);
                setError("");
                void window.runozaDesktop
                  ?.connect(url)
                  .catch((e) => setError(String(e.message)))
                  .finally(() => setBusy(false));
              }}
            >
              {s("Войти через браузер", "Sign in through browser")}
            </Button>
            {code && (
              <Alert
                theme="info"
                title={
                  s(
                    "Подтвердите код в браузере: ",
                    "Confirm this code in your browser: ",
                  ) + code
                }
              />
            )}
            {busy && (
              <Flex gap="spacing-2">
                <Loader size="s" />
                <Text>
                  {s(
                    "Ожидание входа в браузере…",
                    "Waiting for browser sign-in…",
                  )}
                </Text>
              </Flex>
            )}
            {error && <Alert theme="danger" title={error} />}
          </Flex>
        </Card>
      </Flex>
    </Provider>
  );
}
createRoot(document.getElementById("root")!).render(<Connect />);
