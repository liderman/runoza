import { FormLocaleContext } from "@runoza/ui";
import { useContext, type ReactNode } from "react";
import { Box, Flex, Menu, MenuItem } from "@gravity-ui/uikit";
export function SettingsLayout({
  sections,
  value,
  onChange,
  children,
}: {
  sections: { id: string; title: string }[];
  value: string;
  onChange: (id: string) => void;
  children: ReactNode;
}) {
  const locale = useContext(FormLocaleContext);
  return (
    <Flex
      direction={{ xs: "column", m: "row" }}
      gap="spacing-6"
      alignItems="flex-start"
    >
      <Flex
        as="nav"
        aria-label={locale === "ru" ? "Разделы настроек" : "Settings sections"}
        direction={{ xs: "row", m: "column" }}
        wrap="wrap"
        gap="spacing-2"
        width={{ xs: "100%", m: "12rem" }}
        flexShrink={0}
      >
        <Menu
          inline
          size="m"
          aria-label={
            locale === "ru" ? "Разделы настроек" : "Settings sections"
          }
        >
          {sections.map((s) => (
            <MenuItem
              key={s.id}
              selected={value === s.id}
              onClick={() => onChange(s.id)}
              aria-current={value === s.id ? "page" : undefined}
            >
              {s.title}
            </MenuItem>
          ))}
        </Menu>
      </Flex>
      <Box minWidth="0" width="100%" maxWidth="48rem">
        {children}
      </Box>
    </Flex>
  );
}
