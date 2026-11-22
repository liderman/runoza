import { useState } from "react";
import {
  Box,
  Label,
  Button,
  Flex,
  Popup,
  Slider,
  Text,
  Select,
} from "@gravity-ui/uikit";
import { reasoningLevels, type ReasoningProfile } from "@runoza/contracts";
export function ReasoningControl({
  profile,
  value,
  onChange,
  locale,
  disabled,
}: {
  profile?: ReasoningProfile | null;
  value: string;
  onChange: (v: string) => void;
  locale: "ru" | "en";
  disabled: boolean;
}) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null),
    [open, setOpen] = useState(false),
    ru = locale === "ru";
  if (!profile?.levels.length) return null;
  const levels: string[] = [
    ...reasoningLevels.filter((l) => profile.levels.includes(l)),
  ];
  const names: Record<string, string> = ru
    ? {
        default: "По умолчанию",
        none: "Выключено",
        minimal: "Минимально",
        low: "Низко",
        medium: "Средне",
        high: "Высоко",
        xhigh: "Очень высоко",
        max: "Максимально",
      }
    : {
        default: "Default",
        none: "Off",
        minimal: "Minimal",
        low: "Low",
        medium: "Medium",
        high: "High",
        xhigh: "Very high",
        max: "Maximum",
      };
  const effective = value === "default" ? profile.defaultLevel : value;
  const index = effective ? levels.indexOf(effective) : -1;
  const label = effective ? names[effective] : ru ? "Авто" : "Auto";
  const powerful = levels.length > 3 && index === levels.length - 1;

  return (
    <>
      <Button
        className={powerful ? "reasoning-power" : undefined}
        ref={setAnchor}
        view="flat"
        disabled={disabled}
        aria-expanded={open}
        aria-label={(ru ? "Усилие: " : "Effort: ") + label}
        onClick={() => setOpen((v) => !v)}
      >
        {label}
      </Button>
      <Popup
        anchorElement={anchor}
        open={open}
        onOpenChange={setOpen}
        placement="top-start"
        role="dialog"
        aria-label={ru ? "Усилие рассуждений" : "Reasoning effort"}
      >
        <Box className="reasoning-popover" padding="spacing-4">
          <Flex direction="column" gap="spacing-2">
            <Text variant="body-1" color="secondary">
              {ru ? "Усилие рассуждений" : "Reasoning effort"}
            </Text>
            <Flex
              alignItems="center"
              justifyContent="space-between"
              gap="spacing-2"
            >
              <Text
                variant="subheader-2"
                color={powerful ? "warning" : "primary"}
              >
                {label}
              </Text>
              {effective && effective === profile.defaultLevel && (
                <Label size="xs" theme="normal">
                  {ru ? "Рекомендуется" : "Recommended"}
                </Label>
              )}
            </Flex>
            {index < 0 && (
              <Text color="secondary">
                {ru
                  ? "Провайдер не сообщает исходный уровень. Выберите усилие ниже, чтобы задать его явно."
                  : "The provider does not report its initial effort. Choose a level below to set it explicitly."}
              </Text>
            )}
            {index < 0 ? (
              <Select
                aria-label={ru ? "Выберите усилие" : "Choose effort"}
                placeholder={ru ? "Выберите усилие" : "Choose effort"}
                options={levels.map((value) => ({
                  value,
                  content: names[value],
                }))}
                onUpdate={(v) => onChange(v[0]!)}
              />
            ) : (
              <Slider
                value={index < 0 ? 0 : index}
                min={0}
                max={levels.length - 1}
                step={1}
                marks={[]}
                tooltipDisplay="off"
                tooltipFormat={(i) => names[levels[i]!] ?? ""}
                aria-label={ru ? "Усилие рассуждений" : "Reasoning effort"}
                onUpdate={(i) => onChange(levels[i]!)}
                autoFocus
              />
            )}
            <Text variant="caption-2" color="secondary">
              {ru
                ? "Больше усилий может увеличить время ответа и расход токенов."
                : "Higher effort may increase response time and token usage."}
            </Text>
            {powerful && (
              <Text color="warning">
                {ru
                  ? "Максимальное усилие · больше времени и токенов"
                  : "Maximum effort · more time and tokens"}
              </Text>
            )}
            {profile.defaultLevel && effective !== profile.defaultLevel && (
              <Button
                size="s"
                view="flat-secondary"
                onClick={() => onChange("default")}
              >
                {ru
                  ? `Рекомендуется: ${names[profile.defaultLevel]}`
                  : `Recommended: ${names[profile.defaultLevel]}`}
              </Button>
            )}
          </Flex>
        </Box>
      </Popup>
    </>
  );
}
