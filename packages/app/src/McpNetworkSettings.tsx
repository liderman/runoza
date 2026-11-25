import { useEffect, useState } from "react";
import { Alert, Button, Flex, Text, TextArea } from "@gravity-ui/uikit";
import { LoadingPanel } from "@runoza/ui";
import type { IdentityClient } from "@runoza/api-client";
import { useDirtyGuard } from "./NavigationGuard.tsx";
type Settings = { allowedOrigins: string[]; environmentOrigins: string[] };
export function McpNetworkSettings({
  api,
  locale,
}: {
  api: IdentityClient;
  locale: "ru" | "en";
}) {
  const s = (ru: string, en: string) => (locale === "ru" ? ru : en);
  const [saved, setSaved] = useState<Settings | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [reload, setReload] = useState(0);
  const apply = (value: Settings) => {
    setSaved(value);
    setDraft(value.allowedOrigins.join("\n"));
  };
  useEffect(() => {
    let active = true;
    setError("");
    void api
      .request<Settings>("/admin/mcp-network")
      .then((value) => {
        if (active) apply(value);
      })
      .catch(() => {
        if (active)
          setError(
            s("Не удалось загрузить настройки.", "Could not load settings."),
          );
      });
    return () => {
      active = false;
    };
  }, [api, reload]);
  const dirty = saved !== null && draft !== saved.allowedOrigins.join("\n");
  useDirtyGuard(dirty, () => setDraft(saved?.allowedOrigins.join("\n") ?? ""));
  const label = s(
    "Разрешённые локальные адреса MCP",
    "Allowed internal MCP origins",
  );
  return (
    <Flex direction="column" gap="spacing-4">
      <Text variant="subheader-2">{label}</Text>
      <Text color="secondary">
        {s(
          "Укажите адреса, к которым Runoza может подключаться по HTTP или через локальную сеть. Каждый адрес с новой строки: протокол, хост и порт, без пути /private_… и токенов. Изменения применяются без перезапуска.",
          "Allow MCP connections over HTTP or to your local network. Enter one origin per line: scheme, host and port, without paths or tokens. Changes apply without a restart.",
        )}
      </Text>
      {error && <Alert theme="danger" message={error} />}
      {!saved ? (
        error ? (
          <Button onClick={() => setReload((x) => x + 1)}>
            {s("Повторить", "Retry")}
          </Button>
        ) : (
          <LoadingPanel label={s("Загрузка настроек", "Loading settings")} />
        )
      ) : (
        <>
          <TextArea
            value={draft}
            onUpdate={(value) => {
              setDraft(value);
              setDone(false);
            }}
            disabled={busy}
            minRows={4}
            maxRows={10}
            placeholder="http://192.168.1.100:9584"
            controlProps={{ "aria-label": label }}
          />
          {saved.environmentOrigins.length > 0 && (
            <Text color="secondary">
              {s(
                "Также разрешены настройками сервера (здесь не редактируются): ",
                "Also allowed by server configuration (read-only here): ",
              ) + saved.environmentOrigins.join(", ")}
            </Text>
          )}
          {done && (
            <Alert
              theme="success"
              message={s("Настройки сохранены.", "Settings saved.")}
            />
          )}
          <Flex gap="spacing-2" wrap="wrap">
            <Button
              view="action"
              loading={busy}
              disabled={!dirty}
              onClick={() => {
                setBusy(true);
                setError("");
                setDone(false);
                void api
                  .request<Settings>("/admin/mcp-network", "PUT", {
                    allowedOrigins: draft
                      .split("\n")
                      .map((x) => x.trim())
                      .filter(Boolean),
                  })
                  .then((value) => {
                    apply(value);
                    setDone(true);
                  })
                  .catch((e: unknown) => {
                    setError(
                      e &&
                        typeof e === "object" &&
                        "code" in e &&
                        e.code === "MCP_INVALID_ORIGIN"
                        ? s(
                            "Укажите адрес вида http://192.168.1.100:9584 без пути, параметров и токенов. Служебные адреса и маски запрещены.",
                            "Enter an origin such as http://192.168.1.100:9584 without paths, parameters or tokens. Metadata addresses and wildcards are not allowed.",
                          )
                        : s(
                            "Не удалось сохранить настройки. Проверьте права и подключение.",
                            "Could not save settings. Check permissions and connection.",
                          ),
                    );
                  })
                  .finally(() => setBusy(false));
              }}
            >
              {s("Сохранить", "Save")}
            </Button>
            <Button
              disabled={!dirty || busy}
              onClick={() => {
                setDraft(saved.allowedOrigins.join("\n"));
                setError("");
                setDone(false);
              }}
            >
              {s("Отменить изменения", "Reset changes")}
            </Button>
          </Flex>
        </>
      )}
    </Flex>
  );
}
