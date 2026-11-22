import { useState, useEffect } from "react";
import { Dialog, Text, Flex, Button, Alert } from "@gravity-ui/uikit";
import type { IdentityClient } from "@runoza/api-client";
export function DesktopConnect({
  api,
  locale,
}: {
  api: IdentityClient;
  locale: "en" | "ru";
}) {
  const [code, setCode] = useState(
      new URLSearchParams(window.location.search).get("connectDevice") ?? "",
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [done, setDone] = useState(false);
  const ru = locale === "ru";
  return (
    <Dialog
      open={Boolean(code)}
      onOpenChange={(v) => {
        if (!v) setCode("");
      }}
      maxWidth="s"
    >
      <Dialog.Header
        caption={ru ? "Подключить Runóza Desktop" : "Connect Runóza Desktop"}
      />
      <Dialog.Body>
        <Flex direction="column" gap="spacing-3">
          {done ? (
            <Alert
              theme="success"
              title={
                ru
                  ? "Устройство подключено. Вернитесь в приложение."
                  : "Device connected. Return to the app."
              }
            />
          ) : (
            <>
              <Text>
                {ru
                  ? "Подтверждайте только код, показанный в открытом вами приложении Runóza. Устройство получит доступ к вашей учётной записи. Папки и локальные команды разрешаются отдельно на компьютере."
                  : "Only approve the code displayed in the Runóza app you opened. This connects the device to your account. Folders and local commands require separate approval on the computer."}
              </Text>
              <Text variant="display-1">{code}</Text>
            </>
          )}
          {error && <Alert theme="danger" title={error} />}
        </Flex>
      </Dialog.Body>
      <Dialog.Footer
        textButtonCancel={ru ? "Закрыть" : "Close"}
        textButtonApply={
          done ? undefined : ru ? "Подключить устройство" : "Connect device"
        }
        loading={busy}
        onClickButtonCancel={() => setCode("")}
        onClickButtonApply={() => {
          setBusy(true);
          void api
            .request("/desktop/approve", "POST", { code })
            .then(() => {
              setDone(true);
              history.replaceState(null, "", window.location.pathname);
            })
            .catch(() =>
              setError(
                ru
                  ? "Код недействителен или истёк. Начните подключение заново."
                  : "Code is invalid or expired. Start again.",
              ),
            )
            .finally(() => setBusy(false));
        }}
      />
    </Dialog>
  );
}
export function DesktopDevices({
  api,
  locale,
}: {
  api: IdentityClient;
  locale: "en" | "ru";
}) {
  const [devices, setDevices] = useState<
      {
        id: string;
        name: string;
        last_seen: string | null;
        revoked_at: string | null;
      }[]
    >([]),
    [error, setError] = useState("");
  const load = () =>
    api
      .request<{ devices: typeof devices }>("/desktop/devices")
      .then((r) => setDevices(r.devices));
  useEffect(() => {
    void load().catch(() => setError("Could not load devices"));
  }, []);
  const ru = locale === "ru";
  return (
    <Flex direction="column" gap="spacing-3">
      <Text variant="subheader-2">
        {ru ? "Desktop-устройства" : "Desktop devices"}
      </Text>
      {error && <Alert theme="danger" title={error} />}
      {!devices.length && (
        <Text color="secondary">
          {ru ? "Нет подключённых устройств" : "No connected devices"}
        </Text>
      )}
      {devices.map((d) => (
        <Flex
          key={d.id}
          alignItems="center"
          justifyContent="space-between"
          gap="spacing-3"
        >
          <Text>
            {d.name} ·{" "}
            {d.revoked_at
              ? ru
                ? "Доступ отозван"
                : "Revoked"
              : d.last_seen && Date.now() - Date.parse(d.last_seen) < 15000
                ? "Online"
                : "Offline"}
          </Text>
          <Button
            disabled={Boolean(d.revoked_at)}
            view="outlined-danger"
            onClick={() =>
              void api
                .request("/desktop/devices/" + d.id + "/revoke", "POST", {})
                .then(load)
                .catch(() =>
                  setError(
                    ru
                      ? "Не удалось отозвать доступ"
                      : "Could not revoke device",
                  ),
                )
            }
          >
            {ru ? "Отозвать доступ" : "Revoke"}
          </Button>
        </Flex>
      ))}
    </Flex>
  );
}
