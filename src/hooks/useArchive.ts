import { archiveFetch } from "../data/archive-fetch.ts";
import { archiveContextAt, memberPreviewAt } from "../domain/archive-context.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  validateFamily,
  archiveChanges,
  applyArchiveChanges,
  inverseChanges,
  type Change,
  type ChangeConflict,
  type Family,
  type ArchiveUser,
  type PhotoMetadata,
  type TreePreferences,
  DEFAULT_TREE_PREFERENCES,
  isTreeGenerationLimits,
  isArchiveOwner,
  canEditArchive,
} from "../domain";
import { completeArchive } from "../data/archive-pages";
import { fetchWithTimeout, RequestTimeoutError } from "../data/request-timeout";
import {
  readGuestTreePreferences,
  writeGuestTreePreferences,
} from "../data/guest-tree-preferences";

const WRITE_TIMEOUT_MS = 45000;
const UPLOAD_TIMEOUT_MS = 90000;
const RECONCILE_TIMEOUT_MS = 15000;

function treePreferencesFromResponse(data: {
  user?: Pick<ArchiveUser, "approved"> | null;
  treePreferences?: Partial<TreePreferences> | null;
}): TreePreferences {
  const preferences: TreePreferences = {
    reverseTimeline:
      typeof data.treePreferences?.reverseTimeline === "boolean"
        ? data.treePreferences.reverseTimeline
        : DEFAULT_TREE_PREFERENCES.reverseTimeline,
    cardVariant: "portrait",
    colorScheme:
      data.treePreferences?.colorScheme === "white" ? "white" : "warm",
    ...(isTreeGenerationLimits(data.treePreferences?.generationLimits)
      ? { generationLimits: data.treePreferences.generationLimits }
      : {}),
  };
  return data.user?.approved
    ? preferences
    : readGuestTreePreferences(preferences);
}

export function useArchive(enabled = true) {
  const [treePreferences, setTreePreferences] = useState<TreePreferences>(() =>
    readGuestTreePreferences(DEFAULT_TREE_PREFERENCES),
  );
  const [family, setFamily] = useState<Family | null>(null),
    [error, setError] = useState(""),
    [committedUploadNotice, setCommittedUploadNotice] = useState(""),
    [canEdit, setCanEdit] = useState(false),
    [busy, setBusy] = useState(false),
    [attempt, setAttempt] = useState(0);
  const [user, setUser] = useState<ArchiveUser | null>(null);
  const [readTree, setReadTree] = useState(true),
    [readPhotos, setReadPhotos] = useState(true);
  const [local, setLocal] = useState(false);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const revision = useRef(0),
    saving = useRef(false);
  const accessEpoch = useRef(0);
  const accessClosed = useRef(false);
  const loadingController = useRef<AbortController | null>(null);
  const snapshot = useRef<Family | null>(null),
    history = useRef<Change[][]>([]);
  const [undoCount, setUndoCount] = useState(0);
  const [undoRemovesPerson, setUndoRemovesPerson] = useState(false);
  const publishHistory = useCallback(() => {
    setUndoCount(history.current.length);
    setUndoRemovesPerson(
      (history.current.at(-1) || []).some(
        (c) => !c.field && c.collection === "people" && c.before === undefined,
      ),
    );
  }, []);
  const [conflict, setConflict] = useState<{
    fields: ChangeConflict[];
    resolve: (choice: "local" | "remote" | "cancel") => void;
  } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    loadingController.current = controller;
    let active = true;
    const epoch = accessEpoch.current;
    const current = () => active && epoch === accessEpoch.current;
    const timeout = setTimeout(() => controller.abort(), 60000);
    async function load() {
      try {
        const response = await archiveFetch("/api/family?projection=overview", {
          signal: controller.signal,
          cache: "no-store",
        });
        if (current()) setCommittedUploadNotice("");
        const json = response.headers
          .get("content-type")
          ?.includes("application/json");
        if (response.status === 401) {
          let signedIn: ArchiveUser | null = null;
          try {
            const sessionResponse = await archiveFetch("/api/session", {
              signal: controller.signal,
              cache: "no-store",
            });
            if (sessionResponse.ok)
              signedIn = (await sessionResponse.json()).user || null;
          } catch {
            // The original archive error remains useful if session lookup fails.
          }
          if (current()) {
            setNeedsLogin(true);
            setCanEdit(false);
            setFamily(null);
            setUser(signedIn);
          }
          throw new Error(
            signedIn
              ? "Доступ к семейному архиву пока не подтверждён администратором. Профиль доступен в личном кабинете."
              : "Это закрытый семейный архив. Выберите способ входа, чтобы открыть древо.",
          );
        }
        if (!response.ok && response.status !== 404)
          throw new Error("Архив недоступен");
        if (response.ok && json) {
          const initial = await response.json();
          if (current() && initial.partial) {
            setFamily(validateFamily(initial.family));
            setCanEdit(false);
            snapshot.current = null;
            setReadTree(initial.readTree !== false);
            setReadPhotos(initial.readPhotos !== false);
            setTreePreferences(treePreferencesFromResponse(initial));
            setUser(initial.user || null);
            setNeedsLogin(false);
            setError("");
            setLoadingDetails(true);
          }
          const result = await completeArchive(
            initial,
            (url) =>
              archiveFetch(url, {
                signal: controller.signal,
                cache: "no-store",
              }),
            (data) => {
              if (current()) setFamily(data);
            },
          );
          const data = validateFamily(result.family);
          if (current()) {
            accessClosed.current = false;
            setFamily(data);
            snapshot.current = data;
            history.current = [];
            setUndoCount(0);
            setNeedsLogin(false);
            revision.current = result.revision;
            setCanEdit(!memberPreviewAt(window.location.pathname) && result.canEdit === true);
            setLocal(!memberPreviewAt(window.location.pathname) && result.local === true);
            setUser(result.user || null);
            setReadTree(result.readTree !== false);
            setReadPhotos(result.readPhotos !== false);
            setTreePreferences(treePreferencesFromResponse(result));
            setError("");
          }
        } else {
          if (archiveContextAt(window.location.pathname))
            throw new Error("Выбранный архив недоступен");
          const fallback = await archiveFetch("/data/family.json", {
            signal: controller.signal,
          });
          if (!fallback.ok) throw new Error("Не удалось загрузить архив");
          const data = validateFamily(await fallback.json());
          if (current()) {
            setFamily(data);
            setCanEdit(false);
            setError("");
          }
        }
      } catch (reason) {
        if (current()) {
          setCanEdit(false);
          setFamily(null);
          setError(
            reason instanceof Error && reason.name !== "AbortError"
              ? reason.message
              : "Сервер не отвечает. Попробуйте ещё раз.",
          );
        }
      } finally {
        clearTimeout(timeout);
        if (loadingController.current === controller) loadingController.current = null;
        if (current()) setLoadingDetails(false);
      }
    }
    void load();
    return () => {
      active = false;
      if (loadingController.current === controller) loadingController.current = null;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [attempt, enabled]);

  const reconcileAfterUnknownWrite = useCallback(async () => {
    const epoch = accessEpoch.current;
    const response = await fetchWithTimeout(
      "/api/family",
      { cache: "no-store" },
      RECONCILE_TIMEOUT_MS,
      archiveFetch,
    );
    if (epoch !== accessEpoch.current || accessClosed.current) return false;
    if (response.status === 401) {
      setCanEdit(false);
      setNeedsLogin(true);
      return false;
    }
    if (!response.ok) return false;
    const result = await response.json(),
      data = validateFamily(result.family);
    if (epoch !== accessEpoch.current || accessClosed.current) return false;
    snapshot.current = data;
    revision.current = result.revision;
    history.current = [];
    setFamily(data);
    setCanEdit(!memberPreviewAt(window.location.pathname) && result.canEdit === true);
    setLocal(!memberPreviewAt(window.location.pathname) && result.local === true);
    setUser(result.user || null);
    setReadTree(result.readTree !== false);
    setReadPhotos(result.readPhotos !== false);
    setTreePreferences(treePreferencesFromResponse(result));
    setNeedsLogin(false);
    publishHistory();
    return true;
  }, [publishHistory]);

  const write = useCallback(
    async (
      initialUrl: string,
      initialBody: BodyInit,
      headers: Record<string, string>,
      track = true,
      initialChanges?: Change[],
    ) => {
      if (saving.current) throw new Error("Дождитесь завершения сохранения");
      if (!canEdit) throw new Error("Войдите в архив для сохранения изменений");
      if (accessClosed.current) throw new Error("Права просмотра архива изменились. Откройте архив заново.");
      const epoch = accessEpoch.current;
      const assertCurrent = () => {
        if (epoch !== accessEpoch.current || accessClosed.current)
          throw new Error("Права просмотра архива изменились. Откройте архив заново.");
      };
      saving.current = true;
      setBusy(true);
      try {
        let base = snapshot.current,
          url = initialUrl,
          body = initialBody,
          pendingChanges = initialChanges;
        for (let attempt = 0; attempt < 3; attempt++) {
          const familyWrite =
            url === "/api/family" || url === "/api/family/changes";
          let response: Response;
          try {
            response = await fetchWithTimeout(
              url,
              {
                method: url === "/api/family" ? "PUT" : "POST",
                headers: {
                  ...headers,
                  "If-Match": String(revision.current),
                  ...(url === "/api/family/changes"
                    ? { Prefer: "return=minimal" }
                    : {}),
                },
                body,
              },
              familyWrite ? WRITE_TIMEOUT_MS : UPLOAD_TIMEOUT_MS,
              archiveFetch,
            );
          } catch (reason) {
            assertCurrent();
            if (!(reason instanceof RequestTimeoutError)) throw reason;
            let reconciled = false;
            try {
              reconciled = await reconcileAfterUnknownWrite();
            } catch {
              /* Не маскируем исходный неопределённый результат второй ошибкой. */
            }
            throw new Error(
              reconciled
                ? "Сервер не подтвердил сохранение вовремя. Архив перечитан с сервера. Проверьте черновик перед повторным сохранением."
                : "Сервер не подтвердил сохранение вовремя. Не повторяйте действие вслепую: черновик остаётся открытым, обновите архив перед повтором.",
            );
          }
          assertCurrent();
          const result = await response.json();
          assertCurrent();
          if (
            response.status === 409 &&
            familyWrite &&
            base &&
            typeof body === "string"
          ) {
            let freshResponse: Response;
            try {
              freshResponse = await fetchWithTimeout(
                "/api/family",
                { cache: "no-store" },
                RECONCILE_TIMEOUT_MS,
                archiveFetch,
              );
            } catch (reason) {
              if (reason instanceof RequestTimeoutError)
                throw new Error(
                  "Не удалось сверить конфликт изменений: сервер не ответил вовремя. Черновик остаётся открытым.",
                );
              throw reason;
            }
            if (!freshResponse.ok)
              throw new Error(
                "Не удалось сверить изменения. Черновик остаётся открытым.",
              );
            const fresh = await freshResponse.json(),
              current = validateFamily(fresh.family);
            assertCurrent();
            const changes =
              pendingChanges ||
              archiveChanges(base, validateFamily(JSON.parse(body)));
            let merged = applyArchiveChanges(current, changes);
            if (merged.conflicts.length) {
              const choice = await new Promise<"local" | "remote" | "cancel">(
                (resolve) => setConflict({ fields: merged.conflicts, resolve }),
              );
              assertCurrent();
              setConflict(null);
              if (choice === "cancel")
                throw new Error(
                  "Сохранение отложено. Черновик остаётся в форме.",
                );
              merged = applyArchiveChanges(current, changes, choice);
            }
            const mergedFamily = validateFamily(merged.family);
            pendingChanges = archiveChanges(current, mergedFamily);
            body = JSON.stringify({ changes: pendingChanges });
            url = "/api/family/changes";
            base = current;
            snapshot.current = current;
            revision.current = fresh.revision;
            setFamily(current);
            continue;
          }
          if (response.status === 401) {
            setCanEdit(false);
            throw new Error("Сеанс завершён. Войдите в архив ещё раз.");
          }
          if (result.committed === true && result.accessChanged === true) {
            setCommittedUploadNotice("Фотография сохранена, но доступ изменился. Откройте архив заново.");
            setCanEdit(false);
            throw new Error("Фотография сохранена, но доступ изменился. Откройте архив заново.");
          }
          if (result.committed === true && result.refreshRequired === true)
            throw new Error("Фотография сохранена, но архив изменился. Обновите древо перед следующей правкой.");
          if (!response.ok)
            throw new Error(result.error || "Не удалось сохранить изменения");
          const data = validateFamily(
            result.family ||
              (base && Array.isArray(result.appliedChanges)
                ? applyArchiveChanges(base, result.appliedChanges).family
                : undefined),
          );
          assertCurrent();
          if (familyWrite && track && base) {
            const changes = Array.isArray(result.appliedChanges)
              ? (result.appliedChanges as Change[])
              : archiveChanges(base, data);
            if (changes.length)
              history.current = [...history.current.slice(-19), changes];
          } else if (!familyWrite) history.current = [];
          snapshot.current = data;
          revision.current = result.revision;
          setFamily(data);
          publishHistory();
          return data;
        }
        throw new Error(
          "Архив снова изменился. Черновик сохранён в форме; повторите сохранение.",
        );
      } finally {
        saving.current = false;
        setBusy(false);
      }
    },
    [canEdit, publishHistory, reconcileAfterUnknownWrite],
  );
  const save = useCallback(
    (data: Family) => {
      const next = validateFamily(data),
        base = snapshot.current;
      if (!base)
        return write("/api/family", JSON.stringify(next), {
          "Content-Type": "application/json",
        });
      const changes = archiveChanges(base, next);
      if (!changes.length) return Promise.resolve(base);
      return write(
        "/api/family/changes",
        JSON.stringify({ changes }),
        { "Content-Type": "application/json" },
        true,
        changes,
      );
    },
    [write],
  );
  const upload = useCallback(
    (file: File, metadata?: PhotoMetadata) => {
      setCommittedUploadNotice("");
      return write("/api/photos", file, {
        "Content-Type": file.type,
        "X-Drevo-Upload": "1",
        ...(metadata
          ? { "X-Photo-Metadata": encodeURIComponent(JSON.stringify(metadata)) }
          : {}),
      });
    },
    [write],
  );
  const uploadPortrait = useCallback(
    async (file: File) => {
      if (saving.current || !canEdit)
        throw new Error("Загрузка сейчас недоступна");
      setCommittedUploadNotice("");
      saving.current = true;
      setBusy(true);
      try {
        let response: Response;
        try {
          response = await fetchWithTimeout(
            "/api/portraits",
            {
              method: "POST",
              headers: {
                "Content-Type": file.type,
                "X-Drevo-Upload": "1",
                "If-Match": String(revision.current),
              },
              body: file,
            },
            UPLOAD_TIMEOUT_MS,
            archiveFetch,
          );
        } catch (reason) {
          if (reason instanceof RequestTimeoutError)
            throw new Error(
              "Сервер не подтвердил загрузку портрета вовремя. Повторите загрузку; незавершённый файл будет удалён автоматически.",
            );
          throw reason;
        }
        const data = await response.json();
        if (data.committed === true && data.accessChanged === true) {
          setCommittedUploadNotice("Портрет загружен, но доступ изменился. Откройте архив заново.");
          setCanEdit(false);
          throw new Error("Портрет загружен, но доступ изменился. Откройте архив заново.");
        }
        if (data.committed === true && data.refreshRequired === true)
          throw new Error("Портрет загружен, но архив изменился. Обновите древо перед следующей правкой.");
        if (!response.ok)
          throw new Error(data.error || "Не удалось загрузить портрет");
        return data.url as string;
      } finally {
        saving.current = false;
        setBusy(false);
      }
    },
    [canEdit],
  );
  const undo = useCallback(async () => {
    const last = history.current.at(-1),
      current = snapshot.current;
    if (!last || !current) return;
    const changes = inverseChanges(last),
      reversed = applyArchiveChanges(current, changes);
    if (reversed.conflicts.length)
      throw new Error(
        "Эти сведения уже изменились. Отмена могла бы затронуть новые правки.",
      );
    await write(
      "/api/family/changes",
      JSON.stringify({ changes }),
      { "Content-Type": "application/json" },
      false,
      changes,
    );
    history.current.pop();
    publishHistory();
  }, [write, publishHistory]);
  const saveTreePreferences = useCallback(
    async (value: TreePreferences) => {
      if (!user?.approved) {
        writeGuestTreePreferences(value);
        setTreePreferences(value);
        return value;
      }
      const response = await archiveFetch("/api/tree-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(value),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error || "Не удалось сохранить настройки древа");
      const saved = treePreferencesFromResponse({
        treePreferences: result,
        user,
      });
      setTreePreferences(saved);
      return saved;
    },
    [user],
  );
  return {
    conflict,
    getRevision: () => revision.current,
    undo,
    canUndo: undoCount > 0 && (isArchiveOwner(user) || !undoRemovesPerson),
    reverseTimeline: treePreferences.reverseTimeline,
    treePreferences,
    saveTreePreferences,
    user,
    readTree,
    readPhotos,
    needsLogin,
    family,
    loadingDetails,
    error,
    committedUploadNotice,
    dismissCommittedUploadNotice: () => setCommittedUploadNotice(""),
    canEdit,
    local,
    busy,
    save,
    upload,
    uploadPortrait,
    syncSessionUser: (next: ArchiveUser | null) => {
      setUser(next);
      setCanEdit(!memberPreviewAt(window.location.pathname) && canEditArchive(next));
    },
    hasPendingRead: () => loadingController.current !== null,
    closeChangedPrivateView: (revoked: boolean) => {
      // A confirmed identity or read-projection change invalidates the cached tree.
      accessEpoch.current++;
      accessClosed.current = true;
      loadingController.current?.abort();
      setConflict((current) => {
        current?.resolve("cancel");
        return null;
      });
      setFamily(null);
      snapshot.current = null;
      history.current = [];
      setUndoCount(0);
      setUser(null);
      setCanEdit(false);
      setLoadingDetails(false);
      setNeedsLogin(revoked);
      setError(revoked
        ? "Доступ к семейному архиву изменился. Войдите снова или выберите доступный архив."
        : "Права просмотра архива изменились. Откройте архив заново.");
    },
    reload: () => {
      setCommittedUploadNotice("");
      setAttempt((n) => n + 1);
    },
  };
}
