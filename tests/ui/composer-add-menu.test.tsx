import { expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@gravity-ui/uikit";
import { ComposerAddMenu } from "../../packages/app/src/ComposerAddMenu";

for (const theme of ["dark", "light"] as const) {
  test(`composer quick menu: opens, selects and returns focus by keyboard (${theme})`, async () => {
    const user = userEvent.setup();
    const choose = vi.fn();
    render(
      <ThemeProvider theme={theme}>
        <ComposerAddMenu
          locale="en"
          disabled={false}
          attachmentCount={2}
          onChoose={choose}
        />
      </ThemeProvider>,
    );
    const trigger = screen.getByRole("button", {
      name: "Add to message · Attachments (2)",
    });
    await user.tab();
    expect(document.activeElement).toBe(trigger);
    await user.keyboard("{Enter}");
    const first = await screen.findByRole("menuitem", {
      name: "Attachments (2)",
    });
    await waitFor(() => expect(document.activeElement).toBe(first));
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(choose).toHaveBeenCalledWith("mcp");
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    await user.keyboard("{Space}");
    expect(
      await screen.findByRole("menuitem", { name: "Skills" }),
    ).toBeTruthy();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(choose).toHaveBeenCalledTimes(1);
  });
}
