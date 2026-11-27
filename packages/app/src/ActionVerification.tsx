import { Text } from "@gravity-ui/uikit";
import { actionVerification, type CodeAction } from "@runoza/contracts";

export function ActionVerification({
  action,
  locale,
}: {
  action: CodeAction;
  locale: "ru" | "en";
}) {
  const result = actionVerification(action);
  if (!result) return null;
  const labels = {
    passed: ["Проверка пройдена", "Check passed"],
    failed: ["Проверка не пройдена", "Check failed"],
    not_run: ["Проверка не выполнена", "Check not run"],
    unknown: ["Результат проверки неизвестен", "Check result unknown"],
  };
  return (
    <Text
      as="div"
      variant="caption-2"
      color={
        result.outcome === "passed"
          ? "positive"
          : result.outcome === "failed"
            ? "danger"
            : "secondary"
      }
      className="run-verification"
    >
      {labels[result.outcome][locale === "ru" ? 0 : 1]} · {result.label}
      {result.exitCode !== null
        ? ` · ${locale === "ru" ? "код" : "exit"} ${result.exitCode}`
        : ""}
    </Text>
  );
}
