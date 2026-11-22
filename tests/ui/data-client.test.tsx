import { test, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { useQuery } from "@tanstack/react-query";
import {
  AppDataProvider,
  useScopedDataClient,
} from "../../packages/app/src/data-client";
function Value({ load }: { load: () => Promise<string> }) {
  const value = useQuery({ queryKey: ["private-list"], queryFn: load });
  return <output aria-label="Private data">{value.data ?? "loading"}</output>;
}
test("changing authentication scope cannot expose an old in-flight query result", async () => {
  let resolveOld!: (value: string) => void;
  const old = new Promise<string>((resolve) => {
    resolveOld = resolve;
  });
  const view = render(
    <AppDataProvider key="org-a:user-a">
      <Value load={() => old} />
    </AppDataProvider>,
  );
  view.rerender(
    <AppDataProvider key="org-b:user-b">
      <Value load={async () => "user-b data"} />
    </AppDataProvider>,
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Private data").textContent).toBe(
      "user-b data",
    ),
  );
  resolveOld("user-a secret");
  await waitFor(() =>
    expect(screen.getByLabelText("Private data").textContent).toBe(
      "user-b data",
    ),
  );
  expect(screen.queryByText("user-a secret")).toBeNull();
});
test("multiple observers share one request inside the same scope", async () => {
  let calls = 0;
  const load = async () => {
    calls++;
    return "shared list";
  };
  render(
    <AppDataProvider>
      <Value load={load} />
      <Value load={load} />
    </AppDataProvider>,
  );
  await waitFor(() =>
    expect(
      screen
        .getAllByLabelText("Private data")
        .every((e) => e.textContent === "shared list"),
    ).toBe(true),
  );
  expect(calls).toBe(1);
});

function RootValue({
  scope,
  load,
}: {
  scope: string;
  load: () => Promise<string>;
}) {
  const client = useScopedDataClient(scope);
  const query = useQuery(
    { queryKey: [scope, "navigation"], queryFn: load },
    client,
  );
  return (
    <output aria-label="Navigation data">{query.data ?? "loading"}</output>
  );
}
test("root observers survive account changes without retaining the previous account", async () => {
  let finish!: (v: string) => void;
  const old = new Promise<string>((resolve) => {
    finish = resolve;
  });
  const view = render(<RootValue scope="user-a" load={() => old} />);
  view.rerender(
    <RootValue scope="user-b" load={async () => "user-b navigation"} />,
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Navigation data").textContent).toBe(
      "user-b navigation",
    ),
  );
  finish("user-a navigation");
  await waitFor(() =>
    expect(screen.getByLabelText("Navigation data").textContent).toBe(
      "user-b navigation",
    ),
  );
});
