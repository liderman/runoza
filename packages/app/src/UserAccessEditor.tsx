import { useState } from "react";
import {
  Dialog,
  Flex,
  Text,
  RadioGroup,
  Switch,
  Alert,
} from "@gravity-ui/uikit";
import { useDirtyGuard, useNavigationGuard } from "./NavigationGuard.tsx";
import { translator, type Locale } from "./locales.ts";
import { IdentityApiError, type IdentityClient } from "@runoza/api-client";
export interface AccessUser {
  id: string;
  name: string;
  email: string;
  role: "member" | "org_admin";
  systemAdmin: boolean;
  disabled: boolean;
}
export function UserAccessEditor({
  user,
  api,
  locale,
  canSystem,
  onClose,
  onSaved,
}: {
  user: AccessUser;
  api: IdentityClient;
  locale: Locale;
  canSystem: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(user),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const guard = useNavigationGuard(),
    t = translator(locale);
  const dirty = JSON.stringify(draft) !== JSON.stringify(user);
  useDirtyGuard(dirty, () => setDraft(user));
  return (
    <Dialog
      open
      maxWidth="s"
      onOpenChange={(v) => {
        if (!v && !busy) guard.navigate(onClose);
      }}
    >
      <Dialog.Header caption={user.name} />
      <Dialog.Body>
        <Flex direction="column" gap="spacing-5">
          <Text color="secondary">{user.email}</Text>
          {error && <Alert theme="danger" message={t(error)} />}
          <Text variant="subheader-2">{t("role")}</Text>
          <RadioGroup
            value={draft.role}
            options={[
              { value: "member", content: t("member") },
              { value: "org_admin", content: t("orgAdmin") },
            ]}
            onUpdate={(role) =>
              setDraft({ ...draft, role: role as AccessUser["role"] })
            }
            disabled={busy}
          />
          {canSystem && (
            <Switch
              checked={draft.systemAdmin}
              onUpdate={(systemAdmin) => setDraft({ ...draft, systemAdmin })}
              disabled={busy}
            >
              {t("systemAdmin")}
            </Switch>
          )}
          <Switch
            checked={draft.disabled}
            onUpdate={(disabled) => setDraft({ ...draft, disabled })}
            disabled={busy}
          >
            {t("disabled")}
          </Switch>
        </Flex>
      </Dialog.Body>
      <Dialog.Footer
        textButtonCancel={locale === "ru" ? "Отмена" : "Cancel"}
        textButtonApply={t("save")}
        propsButtonApply={{ disabled: !dirty }}
        loading={busy}
        onClickButtonCancel={() => guard.navigate(onClose)}
        onClickButtonApply={() => {
          setBusy(true);
          setError("");
          void api
            .request("/admin/users/" + user.id, "PATCH", {
              role: draft.role,
              disabled: draft.disabled,
              ...(canSystem ? { systemAdmin: draft.systemAdmin } : {}),
            })
            .then(async () => {
              await onSaved();
              onClose();
            })
            .catch((e) =>
              setError(e instanceof IdentityApiError ? e.code : "error"),
            )
            .finally(() => setBusy(false));
        }}
      />
    </Dialog>
  );
}
