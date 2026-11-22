import { LoadingPanel } from "@runoza/ui";
import { useForm, useStore } from "@tanstack/react-form";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useDirtyGuard } from "./NavigationGuard.tsx";
import { useState } from "react";
import {
  Button,
  Select,
  Checkbox,
  Alert,
  Flex,
  Text,
  Card,
  Label,
  Dialog,
  Loader,
  Box,
} from "@gravity-ui/uikit";
import { Field, Panel, FieldLabel } from "@runoza/ui";
import { IdentityApiError, type IdentityClient } from "@runoza/api-client";
import type { ProviderView } from "@runoza/contracts";
import { ModelLogo } from "./ModelFacts.tsx";
import { chatText } from "./chat-locales.ts";
import { uxText } from "./ux-locales.ts";
import { providerForm, type ProviderDraft } from "./provider-form.ts";
const empty = (): ProviderDraft => ({
  name: "OpenRouter",
  kind: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  key: "",
  models: "",
  enabled: true,
  noAuth: false,
});
const draftFor = (p?: ProviderView): ProviderDraft =>
  p
    ? {
        name: p.name,
        kind: p.kind,
        baseUrl: p.base_url,
        key: "",
        models: p.models.join("\n"),
        enabled: p.enabled,
        noAuth: false,
      }
    : empty();
export function ProviderSettings({
  api,
  locale,
  onModels,
}: {
  onModels: () => void;
  api: IdentityClient;
  locale: "en" | "ru";
}) {
  const t = chatText(locale),
    u = uxText(locale),
    [id, setId] = useState(""),
    [editing, setEditing] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [errors, setErrors] = useState<ReturnType<typeof providerForm>["errors"]>(
      {},
    ),
    [pending, setPending] = useState<{
      provider?: ProviderView;
      close?: boolean;
    } | null>(null);
  const [defaults, setDefaults] = useState(empty);
  const form = useForm({ defaultValues: defaults });
  const draft = useStore(form.store, (state) => state.values);
  const atBaseline = useStore(form.store, (state) => state.isDefaultValue);
  const queryClient = useQueryClient();
  const queryKey = ["admin", "providers"] as const;
  const queryFn = async ({ signal }: { signal: AbortSignal }) =>
    (
      await api.request<{ providers: ProviderView[] }>(
        "/admin/providers",
        "GET",
        undefined,
        { signal },
      )
    ).providers;
  const query = useQuery({ queryKey, queryFn });
  const providers = query.data ?? [];
  const presetsQuery = useQuery({
    queryKey: ["admin", "provider-presets"],
    queryFn: ({ signal }) =>
      api.request<{
        presets: {
          id: string;
          name: string;
          baseUrl: string;
          kind: "openrouter" | "compatible";
        }[];
      }>("/admin/provider-presets", "GET", undefined, { signal }),
    staleTime: Infinity,
  });
  const presets = presetsQuery.data?.presets ?? [];

  const loading = query.isPending;
  const mutation = useMutation({
    mutationFn: (fn: () => Promise<void>) => fn(),
  });
  const busy = mutation.isPending;
  const original = providers.find((p) => p.id === id),
    dirty = editing && !atBaseline;
  const changed = providerForm(draft, original).changed;
  const update = (patch: Partial<ProviderDraft>) => {
    for (const key of Object.keys(patch) as (keyof ProviderDraft)[]) {
      form.setFieldValue(key, patch[key]!);
    }
    setErrors({});
    setError("");
    setNotice("");
  };
  useDirtyGuard(dirty, () => {
    form.reset();
    setEditing(false);
  });
  async function refresh() {
    await queryClient.invalidateQueries({ queryKey, refetchType: "none" });
    return queryClient.fetchQuery({ queryKey, queryFn });
  }
  async function action(fn: () => Promise<void>) {
    if (busy) return;
    setError("");
    setNotice("");
    try {
      await mutation.mutateAsync(fn);
    } catch (e) {
      setError(e instanceof IdentityApiError ? e.code : "error");
    }
  }
  function open(p?: ProviderView, close = false) {
    const d = draftFor(p);
    setDefaults(d);
    form.reset(d);
    setId(p?.id ?? "");
    setEditing(!close);
    setError("");
    setNotice("");
    setErrors({});
  }
  function choose(p?: ProviderView, close = false) {
    if (dirty) setPending({ provider: p, close });
    else open(p, close);
  }
  async function save() {
    const validated = providerForm({ ...draft, models: "" }, original);
    setErrors(validated.errors);
    if (Object.keys(validated.errors).length) return;
    await action(async () => {
      const { models: _models, ...payload } = validated.payload;
      const result = await api.request<{ id: string }>(
        "/admin/providers" + (id ? "/" + id : ""),
        id ? "PUT" : "POST",
        payload,
      );
      const all = await refresh();
      await queryClient.invalidateQueries({ queryKey: ["admin", "models"] });
      await queryClient.invalidateQueries({ queryKey: ["models"] });
      open(all.find((p) => p.id === result.id));
      setNotice(u("providerSaved"));
    });
  }
  return (
    <Flex direction="column" gap="spacing-6">
      <Flex
        justifyContent="space-between"
        alignItems="center"
        gap="spacing-3"
        wrap="wrap"
      >
        <Text color="secondary">
          {providers.length ? u("selectProvider") : u("noProvidersHint")}
        </Text>
        <Flex gap="spacing-2" wrap="wrap">
          <Button size="l" onClick={onModels}>
            {locale === "ru" ? "Управлять моделями" : "Manage models"}
          </Button>
          <Button
            view="action"
            size="l"
            disabled={busy}
            onClick={() => choose()}
          >
            {t("addProvider")}
          </Button>
        </Flex>
      </Flex>
      {query.isError && <Alert theme="danger" message={t("error")} />}
      {loading ? (
        <LoadingPanel label={locale === "ru" ? "Загрузка" : "Loading"} />
      ) : (
        <Flex direction="column" gap="spacing-4" alignItems="stretch">
          <Flex direction="column" gap="spacing-3" width="100%" flexShrink={0}>
            {!providers.length && <Text>{u("noProviders")}</Text>}
            {providers.map((p) => (
              <Card key={p.id} view="outlined" padding="spacing-4">
                <Flex
                  alignItems="center"
                  justifyContent="space-between"
                  wrap="wrap"
                  gap="spacing-3"
                >
                  <Flex alignItems="center" gap="spacing-2" minWidth="0">
                    <ModelLogo brand={p.providerBrand} />
                    <Text variant="subheader-2" ellipsis>
                      {p.name}
                    </Text>
                  </Flex>
                  <Flex gap="spacing-2" wrap="wrap">
                    <Label theme={p.enabled ? "success" : "unknown"}>
                      {p.enabled ? t("enabled") : t("disabled")}
                    </Label>
                    <Text color="secondary">
                      {locale === "ru" ? "Модели: " : "Models: "}
                      {p.models.length}
                    </Text>
                  </Flex>
                  <Button
                    view={
                      p.id === id && editing ? "outlined-action" : "outlined"
                    }
                    disabled={busy}
                    onClick={() => choose(p)}
                  >
                    {u("edit")}
                  </Button>
                </Flex>
              </Card>
            ))}
          </Flex>
          <Box minWidth="0">
            {editing ? (
              <Dialog
                open
                maxWidth="m"
                onOpenChange={(value) => {
                  if (!value && !busy) choose(undefined, true);
                }}
              >
                <Dialog.Header
                  caption={
                    id ? t("edit") + " · " + draft.name : t("addProvider")
                  }
                />
                <Dialog.Body>
                  <Flex direction="column" gap="spacing-5">
                    {error && <Alert theme="danger" message={t(error)} />}{" "}
                    {notice && <Alert theme="success" message={notice} />}
                    <Flex
                      as="form"
                      direction="column"
                      gap="spacing-5"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void save();
                      }}
                    >
                      {!id && presets.length > 0 && (
                        <Flex direction="column" gap="spacing-2">
                          <FieldLabel
                            label={
                              locale === "ru"
                                ? "Шаблон провайдера"
                                : "Provider preset"
                            }
                            help={
                              locale === "ru"
                                ? "Адрес из models.dev. Совместимость конкретного endpoint проверяется при подключении. Секреты не загружаются из справочника."
                                : "Endpoint from models.dev. Test the connection before use. Credentials are never loaded from the catalog."
                            }
                          />
                          <Select
                            aria-label={
                              locale === "ru"
                                ? "Шаблон провайдера"
                                : "Provider preset"
                            }
                            size="l"
                            filterable
                            placeholder={
                              locale === "ru"
                                ? "Выберите или настройте вручную"
                                : "Choose a preset or configure manually"
                            }
                            options={presets.map((p) => ({
                              value: p.id,
                              content: p.name,
                            }))}
                            onUpdate={(values) => {
                              const p = presets.find((p) => p.id === values[0]);
                              if (p)
                                update({
                                  name: p.name,
                                  kind: p.kind,
                                  baseUrl: p.baseUrl,
                                  key: "",
                                  noAuth: false,
                                });
                            }}
                          />
                        </Flex>
                      )}
                      <Field
                        label={t("providerName")}
                        value={draft.name}
                        onChange={(name) => update({ name })}
                        maxLength={120}
                        error={errors.name ? u(errors.name) : undefined}
                        disabled={busy}
                      />
                      <Flex direction="column" gap="spacing-2">
                        <FieldLabel label={u("providerType")} />
                        <Select
                          aria-label={u("providerType")}
                          size="l"
                          disabled={busy}
                          value={[draft.kind]}
                          options={[
                            { value: "openrouter", content: "OpenRouter" },
                            {
                              value: "compatible",
                              content: "OpenAI-compatible / LiteLLM",
                            },
                          ]}
                          onUpdate={(v) => {
                            const kind = v[0] as ProviderDraft["kind"];
                            update({
                              kind,
                              baseUrl:
                                kind === "openrouter"
                                  ? "https://openrouter.ai/api/v1"
                                  : "http://host.docker.internal:11434/v1",
                              key: "",
                              noAuth: false,
                            });
                          }}
                        />
                      </Flex>
                      <Field
                        label={t("endpoint")}
                        value={draft.baseUrl}
                        onChange={(baseUrl) => update({ baseUrl })}
                        maxLength={2048}
                        type="url"
                        help={u("endpointHelp")}
                        error={errors.baseUrl ? u(errors.baseUrl) : undefined}
                        disabled={busy}
                      />
                      <Field
                        label={u("providerKey")}
                        value={draft.key}
                        onChange={(key) => update({ key })}
                        type="password"
                        autoComplete="new-password"
                        maxLength={4096}
                        required={false}
                        disabled={busy || draft.noAuth}
                        help={u("keyNew")}
                        description={
                          changed
                            ? u("keyChanged")
                            : id
                              ? u("keyKeep")
                              : draft.kind === "compatible"
                                ? u("keyLocal")
                                : u("keyNew")
                        }
                        error={errors.key ? u(errors.key) : undefined}
                      />
                      {draft.kind === "compatible" && (
                        <Checkbox
                          checked={draft.noAuth}
                          disabled={busy}
                          onUpdate={(noAuth) => update({ noAuth, key: "" })}
                          content={u("noAuth")}
                        />
                      )}
                      <Text color="secondary">
                        {locale === "ru"
                          ? "Каталог загрузится после сохранения. Включите нужные модели в разделе «Модели»."
                          : "The catalog loads after saving. Enable models in the Models section."}
                      </Text>
                      <Checkbox
                        checked={draft.enabled}
                        onUpdate={(enabled) => update({ enabled })}
                        content={t("enabled")}
                        disabled={busy}
                      />
                      <Flex gap="spacing-3" wrap="wrap">
                        <Button
                          type="submit"
                          view="action"
                          size="l"
                          loading={busy}
                        >
                          {u("saveProvider")}
                        </Button>
                        <Button
                          size="l"
                          disabled={busy}
                          onClick={() => choose(undefined, true)}
                        >
                          {u("cancel")}
                        </Button>
                      </Flex>
                    </Flex>
                    {id && (
                      <Flex
                        direction="column"
                        gap="spacing-3"
                        alignItems="flex-start"
                      >
                        <Button
                          disabled={busy || dirty}
                          onClick={() =>
                            void action(async () => {
                              await api.request<{ models: string[] }>(
                                "/admin/providers/" + id + "/test",
                                "POST",
                              );

                              setNotice(t("ready"));
                            })
                          }
                        >
                          {u("savedTest")}
                        </Button>
                        {dirty && (
                          <Text color="secondary">{u("saveBeforeTest")}</Text>
                        )}
                      </Flex>
                    )}
                  </Flex>
                </Dialog.Body>
              </Dialog>
            ) : error ? (
              <Alert theme="danger" message={t(error)} />
            ) : null}
          </Box>
        </Flex>
      )}
      <Dialog
        open={Boolean(pending)}
        onOpenChange={(v) => {
          if (!v) setPending(null);
        }}
      >
        <Dialog.Header caption={u("unsaved")} />
        <Dialog.Body>{u("unsavedHint")}</Dialog.Body>
        <Dialog.Footer
          textButtonCancel={u("cancel")}
          textButtonApply={u("discard")}
          onClickButtonCancel={() => setPending(null)}
          onClickButtonApply={() => {
            open(pending?.provider, pending?.close);
            setPending(null);
          }}
        />
      </Dialog>
    </Flex>
  );
}
