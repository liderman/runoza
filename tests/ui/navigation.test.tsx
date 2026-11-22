import { useState } from "react";
import { describe, test, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@gravity-ui/uikit";
import {
  NavigationGuard,
  UnsavedDialog,
  useDirtyGuard,
  useNavigationGuard,
} from "../../packages/app/src/NavigationGuard";
function Form() {
  const [value, setValue] = useState("");
  const [page, setPage] = useState("form");
  useDirtyGuard(value !== "", () => setValue(""));
  const guard = useNavigationGuard();
  return (
    <>
      <input
        aria-label="Draft"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <button onClick={() => guard.navigate(() => setPage("destination"))}>
        Navigate
      </button>
      <button onClick={() => setValue("")}>Cancel draft</button>
      <output aria-label="Page">{page}</output>
    </>
  );
}
for (const theme of ["light", "dark"] as const)
  for (const locale of ["en", "ru"] as const) {
    describe(`${theme}/${locale}: unsaved changes`, () => {
      const mount = () =>
        render(
          <ThemeProvider theme={theme}>
            <NavigationGuard>
              <Form />
              <UnsavedDialog locale={locale} />
            </NavigationGuard>
          </ThemeProvider>,
        );
      test("clean form navigates without a warning", async () => {
        mount();
        const user = userEvent.setup();
        await user.click(
          await screen.findByRole("button", { name: "Navigate" }),
        );
        expect(screen.getByLabelText("Page").textContent).toBe("destination");
        expect(screen.queryByRole("dialog")).toBeNull();
      });
      test("keep editing preserves draft; discard resumes the requested navigation", async () => {
        mount();
        const user = userEvent.setup();
        await user.type(screen.getByLabelText("Draft"), "unsaved text");
        await user.click(
          await screen.findByRole("button", { name: "Navigate" }),
        );
        expect(screen.getByLabelText("Page").textContent).toBe("form");
        await user.click(
          await screen.findByRole("button", {
            name:
              locale === "ru" ? "Продолжить редактирование" : "Keep editing",
          }),
        );
        expect((screen.getByLabelText("Draft") as HTMLInputElement).value).toBe(
          "unsaved text",
        );
        await user.click(
          await screen.findByRole("button", { name: "Navigate" }),
        );
        await user.click(
          await screen.findByRole("button", {
            name: locale === "ru" ? "Не сохранять" : "Discard changes",
          }),
        );
        await waitFor(() =>
          expect(screen.getByLabelText("Page").textContent).toBe("destination"),
        );
        expect((screen.getByLabelText("Draft") as HTMLInputElement).value).toBe(
          "",
        );
      });
      test("cancelling a draft clears the guard", async () => {
        mount();
        const user = userEvent.setup();
        await user.type(screen.getByLabelText("Draft"), "cancelled text");
        await user.click(screen.getByRole("button", { name: "Cancel draft" }));
        await user.click(
          await screen.findByRole("button", { name: "Navigate" }),
        );
        expect(screen.getByLabelText("Page").textContent).toBe("destination");
        expect(screen.queryByRole("dialog")).toBeNull();
      });
    });
  }
