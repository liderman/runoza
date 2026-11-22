import type { ErrorComponentProps } from "@tanstack/react-router";
import { Provider, Flex, Alert, Button } from "@gravity-ui/uikit";
import { BrandLogo } from "@runoza/ui";
/** Recovery also works when a lazy chunk from an older release is no longer available. */
export function RouteErrorPage(_props: ErrorComponentProps) {
  const ru = document.documentElement.lang.startsWith("ru");
  let theme: "light" | "dark" = "dark";
  try {
    if (localStorage.getItem("runoza.theme") === "light") theme = "light";
  } catch {}
  return (
    <Provider theme={theme} lang={ru ? "ru" : "en"}>
      {window.runozaDesktop?.platform === "darwin" && (
        <div className="desktop-titlebar">Runóza</div>
      )}
      <Flex
        direction="column"
        gap="spacing-6"
        padding="spacing-6"
        maxWidth="40rem"
        marginInline="auto"
        paddingBlockStart="spacing-10"
      >
        <BrandLogo />
        <Alert
          theme="warning"
          title={
            ru ? "Не удалось открыть раздел" : "Could not open this section"
          }
          message={
            ru
              ? "Перезагрузите интерфейс и попробуйте ещё раз."
              : "Reload the interface and try again."
          }
          actions={
            <Flex gap="spacing-2" wrap="wrap">
              <Button view="action" onClick={() => window.location.reload()}>
                {ru ? "Перезагрузить" : "Reload"}
              </Button>
              <Button
                disabled={window.history.length <= 1}
                onClick={() => window.history.back()}
              >
                {ru ? "Назад" : "Back"}
              </Button>
            </Flex>
          }
        />
      </Flex>
    </Provider>
  );
}
