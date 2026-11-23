import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Dialog,
  Flex,
  Select,
  Text,
  TextInput,
} from "@gravity-ui/uikit";
import type { IdentityClient } from "@runoza/api-client";
import type { FileView } from "@runoza/contracts";
type Collection = { id: string; name: string; fileIds: string[] };
export function useCollections(
  api: IdentityClient,
  project: string,
  enabled = true,
) {
  return useQuery({
    queryKey: ["project-collections", project],
    enabled: Boolean(project) && enabled,
    queryFn: async ({ signal }) =>
      (
        await api.request<{ collections: Collection[] }>(
          "/projects/" + project + "/collections",
          "GET",
          undefined,
          { signal },
        )
      ).collections,
  });
}
export function ProjectCollections({
  api,
  project,
  files,
  locale,
  readOnly,
}: {
  api: IdentityClient;
  project: string;
  files: FileView[];
  locale: "ru" | "en";
  readOnly: boolean;
}) {
  const ru = locale === "ru",
    q = useCollections(api, project),
    client = useQueryClient();
  const [draft, setDraft] = useState<Collection | null>(null),
    [remove, setRemove] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  function open(c: Collection) {
    setDraft(c);
    setError("");
    setRemove(false);
  }
  async function save() {
    if (!draft) return;
    setBusy(true);
    setError("");
    try {
      await api.request(
        "/projects/" +
          project +
          "/collections" +
          (draft.id ? "/" + draft.id : ""),
        remove ? "DELETE" : draft.id ? "PUT" : "POST",
        remove
          ? undefined
          : { name: draft.name.trim(), fileIds: draft.fileIds },
      );
      await client.invalidateQueries({
        queryKey: ["project-collections", project],
      });
      setDraft(null);
    } catch (e) {
      setError(
        (e as { code?: string }).code === "COLLECTION_NAME_TAKEN"
          ? ru
            ? "Это название уже занято"
            : "This name is already in use"
          : ru
            ? "Не удалось сохранить коллекцию"
            : "Could not save collection",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Flex direction="column" gap="spacing-2">
      <Flex alignItems="center" gap="spacing-2">
        <Text variant="subheader-1">{ru ? "Коллекции" : "Collections"}</Text>
        {!readOnly && (
          <Button
            size="s"
            onClick={() => open({ id: "", name: "", fileIds: [] })}
          >
            {ru ? "Создать коллекцию" : "Create collection"}
          </Button>
        )}
      </Flex>
      {q.isError && (
        <Alert
          theme="danger"
          message={
            ru ? "Не удалось загрузить коллекции" : "Could not load collections"
          }
        />
      )}
      <Flex wrap="wrap" gap="spacing-2">
        {q.data?.map((c) =>
          readOnly ? (
            <Text key={c.id}>
              {c.name} · {c.fileIds.length}
            </Text>
          ) : (
            <Button key={c.id} size="s" onClick={() => open({ ...c })}>
              {c.name} · {c.fileIds.length}
            </Button>
          ),
        )}
      </Flex>
      <Dialog
        open={!!draft}
        onOpenChange={(o) => {
          if (!o && !busy) setDraft(null);
        }}
      >
        <Dialog.Header
          caption={
            remove
              ? ru
                ? "Удалить коллекцию?"
                : "Delete collection?"
              : ru
                ? "Коллекция файлов"
                : "File collection"
          }
        />
        <Dialog.Body>
          {draft &&
            (!remove ? (
              <Flex direction="column" gap="spacing-3">
                <label>
                  {ru ? "Название" : "Name"}
                  <TextInput
                    value={draft.name}
                    onUpdate={(name) => setDraft({ ...draft, name })}
                    controlProps={{ maxLength: 120 }}
                  />
                </label>
                <Text>{ru ? "Файлы коллекции" : "Collection files"}</Text>
                <Select
                  aria-label={ru ? "Файлы коллекции" : "Collection files"}
                  multiple
                  filterable
                  width="max"
                  value={draft.fileIds}
                  onUpdate={(fileIds) => setDraft({ ...draft, fileIds })}
                  options={files
                    .filter(
                      (f) =>
                        f.status === "ready" && /\.(pdf|txt|md)$/i.test(f.name),
                    )
                    .map((f) => ({ value: f.id, content: f.name }))}
                />
                <Text color="secondary">
                  {ru
                    ? "В поиск попадут файлы с включённой индексацией."
                    : "Search uses collection files with indexing enabled."}
                </Text>
                {draft.id && (
                  <Button view="flat-danger" onClick={() => setRemove(true)}>
                    {ru ? "Удалить коллекцию" : "Delete collection"}
                  </Button>
                )}
              </Flex>
            ) : (
              <Text>
                {draft.name} ·{" "}
                {ru
                  ? "Файлы останутся в проекте."
                  : "Files will stay in the project."}
              </Text>
            ))}
          {error && <Alert theme="danger" message={error} />}
        </Dialog.Body>
        <Dialog.Footer
          loading={busy}
          propsButtonApply={{ disabled: !draft?.name.trim() }}
          textButtonApply={
            remove ? (ru ? "Удалить" : "Delete") : ru ? "Сохранить" : "Save"
          }
          textButtonCancel={ru ? "Отмена" : "Cancel"}
          onClickButtonCancel={() => setDraft(null)}
          onClickButtonApply={() => void save()}
        />
      </Dialog>
    </Flex>
  );
}
