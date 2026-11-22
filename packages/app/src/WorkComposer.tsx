import { Flex, Stepper, Text, useLayoutContext } from "@gravity-ui/uikit";
/** Shared navigation for manual and recurring background work. */
export function WorkComposerSteps({
  value,
  onChange,
  locale,
}: {
  value: number;
  onChange: (value: number) => void;
  locale: "ru" | "en";
}) {
  const { isMediaActive } = useLayoutContext();
  const compact = !isMediaActive("m");
  const titles =
    locale === "ru"
      ? ["Задача", "Место", "Запуск", "Правила"]
      : ["Task", "Place", "Timing", "Rules"];
  return (
    <Flex
      direction="column"
      gap="spacing-2"
      overflow="auto"
      paddingBlockEnd="spacing-2"
    >
      <Stepper
        size="s"
        style={{ margin: 0, padding: 0 }}
        value={String(value)}
        aria-label={
          locale === "ru" ? "Настройка фоновой работы" : "Background work setup"
        }
        onUpdate={(value) => onChange(Number(value ?? 0))}
      >
        {titles.map((title, index) => (
          <Stepper.Item
            key={index}
            id={String(index)}
            aria-label={title}
            aria-current={value === index ? "step" : undefined}
          >
            {compact ? String(index + 1) : title}
          </Stepper.Item>
        ))}
      </Stepper>
      {compact && (
        <Text variant="caption-2" color="secondary" aria-live="polite">
          {value + 1} / {titles.length} · {titles[value]}
        </Text>
      )}
    </Flex>
  );
}
