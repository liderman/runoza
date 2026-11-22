import {
  createContext,
  useContext,
  useId,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import {
  Card,
  Text,
  TextInput,
  NumberInput,
  Skeleton,
  TextArea,
  Flex,
  HelpMark,
  Box,
} from "@gravity-ui/uikit";
export const FormLocaleContext = createContext<"en" | "ru">("en");
export function Panel({
  title,
  children,
  description,
}: {
  title: string;
  children: ReactNode;
  description?: string;
}) {
  return (
    <Card
      type="container"
      view="outlined"
      padding={{ xs: "spacing-4", m: "spacing-6" }}
    >
      <Flex direction="column" gap="spacing-5" minWidth="0">
        <Flex direction="column" gap="spacing-2">
          <Text variant="subheader-3">{title}</Text>
          {description && <Text color="secondary">{description}</Text>}
        </Flex>
        {children}
      </Flex>
    </Card>
  );
}
export function FieldLabel({
  label,
  htmlFor,
  help,
  required = false,
}: {
  label: string;
  htmlFor?: string;
  help?: string;
  required?: boolean;
}) {
  return (
    <Flex gap="spacing-2" alignItems="center">
      <Text as="label" htmlFor={htmlFor} variant="body-2">
        {label}
        {required && (
          <Text color="danger" aria-hidden="true">
            {" "}
            *
          </Text>
        )}
      </Text>
      {help && (
        <HelpMark aria-label={label}>
          <Box width="22rem" maxWidth="calc(100vw - 4rem)">
            {help}
          </Box>
        </HelpMark>
      )}
    </Flex>
  );
}
export function Field({
  label,
  inputRef,
  value,
  onChange,
  type = "text",
  required = true,
  autoComplete,
  maxLength,
  minLength,
  help,
  description,
  placeholder,
  error,
  disabled = false,
}: {
  label: string;
  inputRef?: Ref<HTMLInputElement>;
  value: string;
  onChange: (s: string) => void;
  type?: "text" | "email" | "password" | "url";
  required?: boolean;
  autoComplete?: string;
  maxLength?: number;
  minLength?: number;
  help?: string;
  description?: string;
  placeholder?: string;
  error?: string;
  disabled?: boolean;
}) {
  const id = useId(),
    locale = useContext(FormLocaleContext),
    [invalid, setInvalid] = useState("");
  const message = error || invalid;
  function validate(input: HTMLInputElement) {
    const v = input.validity;
    return v.valueMissing
      ? locale === "ru"
        ? "Заполните это поле."
        : "Fill in this field."
      : v.typeMismatch
        ? locale === "ru"
          ? type === "email"
            ? "Введите корректный email."
            : "Введите полный адрес, включая https://."
          : type === "email"
            ? "Enter a valid email."
            : "Enter a complete URL, including https://."
        : v.tooShort
          ? locale === "ru"
            ? `Минимум ${minLength} символов.`
            : `Use at least ${minLength} characters.`
          : input.validationMessage;
  }
  return (
    <Flex direction="column" gap="spacing-2" minWidth="0">
      <FieldLabel label={label} htmlFor={id} help={help} required={required} />
      <TextInput
        controlRef={inputRef}
        id={id}
        value={value}
        onUpdate={(v) => {
          setInvalid("");
          onChange(v);
        }}
        type={type}
        size="l"
        disabled={disabled}
        autoComplete={autoComplete}
        placeholder={placeholder}
        validationState={message ? "invalid" : undefined}
        errorMessage={message}
        controlProps={{
          required,
          maxLength:
            maxLength ??
            (type === "password"
              ? 128
              : type === "email"
                ? 254
                : type === "url"
                  ? 2048
                  : 200),
          minLength,
          "aria-describedby": description ? id + "-hint" : undefined,
          onInvalid: (e) => {
            e.preventDefault();
            setInvalid(validate(e.currentTarget));
            e.currentTarget.focus();
          },
        }}
      />
      {description && (
        <Text id={id + "-hint"} color="secondary" variant="body-1">
          {description}
        </Text>
      )}
    </Flex>
  );
}
export function MultilineField({
  label,
  value,
  onChange,
  help,
  description,
  placeholder,
  maxLength = 16000,
  minRows = 6,
  error,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  help?: string;
  description?: string;
  placeholder?: string;
  maxLength?: number;
  minRows?: number;
  error?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <Flex direction="column" gap="spacing-2">
      <FieldLabel label={label} htmlFor={id} help={help} />
      <TextArea
        id={id}
        size="l"
        value={value}
        onUpdate={onChange}
        minRows={minRows}
        maxRows={16}
        placeholder={placeholder}
        disabled={disabled}
        validationState={error ? "invalid" : undefined}
        errorMessage={error}
        note={`${value.length.toLocaleString()} / ${maxLength.toLocaleString()}`}
        controlProps={{
          maxLength,
          "aria-describedby": description ? id + "-hint" : undefined,
        }}
      />
      {description && (
        <Text id={id + "-hint"} color="secondary">
          {description}
        </Text>
      )}
    </Flex>
  );
}

export function NumericField({
  label,
  value,
  onChange,
  help,
  description,
  error,
  placeholder,
  disabled = false,
  required = true,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  help?: string;
  description?: string;
  error?: string;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
}) {
  const id = useId();
  return (
    <Flex direction="column" gap="spacing-2" minWidth="0">
      <FieldLabel label={label} htmlFor={id} help={help} required={required} />
      <NumberInput
        id={id}
        value={value === "" ? null : Number(value)}
        onUpdate={(v) => onChange(v === null ? "" : String(v))}
        disabled={disabled}
        size="l"
        allowDecimal={false}
        placeholder={placeholder}
        validationState={error ? "invalid" : undefined}
        errorMessage={error}
        controlProps={{
          required,
          "aria-describedby": description ? id + "-hint" : undefined,
        }}
      />
      {description && (
        <Text id={id + "-hint"} color="secondary">
          {description}
        </Text>
      )}
    </Flex>
  );
}
export function LoadingPanel({ label }: { label: string }) {
  return (
    <Flex
      role="status"
      aria-label={label}
      direction="column"
      gap="spacing-4"
      width="100%"
      paddingBlock="spacing-3"
    >
      <Skeleton variant="text" width="40%" />
      <Skeleton height={48} />
      <Skeleton height={48} />
      <Skeleton variant="text" width="65%" />
    </Flex>
  );
}
