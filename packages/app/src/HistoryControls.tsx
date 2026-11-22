import { ArrowLeft, ArrowRight } from "@gravity-ui/icons";
import { ActionTooltip, Button, Flex, Icon } from "@gravity-ui/uikit";
import { useHotkeys, useFormatForDisplay } from "@tanstack/react-hotkeys";
import { useNavigationHistory } from "./navigation.tsx";
import { useNavigationGuard } from "./NavigationGuard.tsx";
export const navigationShortcuts = { back: "Mod+[", forward: "Mod+]" } as const;
export function HistoryControls({ locale }: { locale: "en" | "ru" }) {
  const history = useNavigationHistory();
  const guard = useNavigationGuard();
  const goBack = () => guard.navigate(history.back);
  const goForward = () => guard.navigate(history.forward);
  const format = useFormatForDisplay();
  const back = locale === "ru" ? "Назад" : "Back";
  const forward = locale === "ru" ? "Вперёд" : "Forward";
  useHotkeys(
    [
      {
        hotkey: navigationShortcuts.back,
        callback: goBack,
        options: {
          enabled: history.canBack && !guard.pending,
          meta: { name: back },
        },
      },
      {
        hotkey: navigationShortcuts.forward,
        callback: goForward,
        options: {
          enabled: history.canForward && !guard.pending,
          meta: { name: forward },
        },
      },
    ],
    { requireReset: true, ignoreDefaultPrevented: true },
  );
  return (
    <Flex
      className="navigation-history-controls"
      gap="spacing-1"
      alignItems="center"
    >
      <ActionTooltip
        title={back}
        description={format(navigationShortcuts.back)}
      >
        <Button
          view="flat"
          size="m"
          aria-label={back}
          disabled={!history.canBack}
          onClick={goBack}
        >
          <Icon data={ArrowLeft} />
        </Button>
      </ActionTooltip>
      <ActionTooltip
        title={forward}
        description={format(navigationShortcuts.forward)}
      >
        <Button
          view="flat"
          size="m"
          aria-label={forward}
          disabled={!history.canForward}
          onClick={goForward}
        >
          <Icon data={ArrowRight} />
        </Button>
      </ActionTooltip>
    </Flex>
  );
}
