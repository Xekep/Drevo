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
} from "../domain";
export function useArchive() {
  const [reverseTimeline, setReverseTimeline] = useState(false);
  const [family, setFamily] = useState<Family | null>(null),
    [error, setError] = useState(""),
    [canEdit, setCanEdit] = useState(false),
    [busy, setBusy] = useState(false),
    [attempt, setAttempt] = useState(0);
  const [user, setUser] = useState<ArchiveUser | null>(null);
  const [readTree, setReadTree] = useState(true),
    [readPhotos, setReadPhotos] = useState(true);
  const [local, setLocal] = useState(false);
  const [needsLogin, setNeedsLogin] = useState(false);
  const revision = useRef(0),
    saving = useRef(false);
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
    const controller = new AbortController();
    let active = true;
    const timeout = setTimeout(() => controller.abort(), 15000);
    async function load() {
      try {
        const response = await fetch("/api/family", {
          signal: controller.signal,
          cache: "no-store",
        });
        const json = response.headers
          .get("content-type")
          ?.includes("application/json");
        if (response.status === 401) {
          if (active) {
            setNeedsLogin(true);
            setCanEdit(false);
            setFamily(null);
          }
          throw new Error(
            "Это закрытый семейный архив. Нажмите «Войти», чтобы открыть древо.",
          );
        }
        if (!response.ok && response.status !== 404)
          throw new Error("Архив недоступен");
        if (response.ok && json) {
          const result = await response.json(),
            data = validateFamily(result.family);
          if (active) {
            setFamily(data);
            snapshot.current = data;
            history.current = [];
            setUndoCount(0);
            setNeedsLogin(false);
            revision.current = result.revision;
            setCanEdit(result.canEdit === true);
            setLocal(result.local === true);
            setUser(result.user || null);
            setReadTree(result.readTree !== false);
            setReadPhotos(result.readPhotos !== false);
            setReverseTimeline(result.reverseTimeline === true);
            setError("");
          }
        } else {
          const fallback = await fetch("/data/family.json", {
            signal: controller.signal,
          });
          if (!fallback.ok) throw new Error("Не удалось загрузить архив");
          const data = validateFamily(await fallback.json());
          if (active) {
            setFamily(data);
            setCanEdit(false);
            setError("");
          }
        }
      } catch (reason) {
        if (active)
          setError(
            reason instanceof Error && reason.name !== "AbortError"
              ? reason.message
              : "Сервер не отвечает. Попробуйте ещё раз.",
          );
      } finally {
        clearTimeout(timeout);
      }
    }
    void load();
    return () => {
      active = false;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [attempt]);
  const write = useCallback(
    async (
      url: string,
      body: BodyInit,
      headers: Record<string, string>,
      track = true,
    ) => {
      if (saving.current) throw new Error("Дождитесь завершения сохранения");
      if (!canEdit) throw new Error("Войдите в архив для сохранения изменений");
      saving.current = true;
      setBusy(true);
      try {
        let base = snapshot.current;
        for (let attempt = 0; attempt < 3; attempt++) {
          const response = await fetch(url, {
            method: url === "/api/family" ? "PUT" : "POST",
            headers: { ...headers, "If-Match": String(revision.current) },
            body,
          });
          const result = await response.json();
          if (
            response.status === 409 &&
            url === "/api/family" &&
            base &&
            typeof body === "string"
          ) {
            const freshResponse = await fetch("/api/family", {
              cache: "no-store",
            });
            if (!freshResponse.ok)
              throw new Error(
                "Не удалось сверить изменения. Черновик остаётся открытым.",
              );
            const fresh = await freshResponse.json(),
              current = validateFamily(fresh.family);
            const changes = archiveChanges(
              base,
              validateFamily(JSON.parse(body)),
            );
            let merged = applyArchiveChanges(current, changes);
            if (merged.conflicts.length) {
              const choice = await new Promise<"local" | "remote" | "cancel">(
                (resolve) => setConflict({ fields: merged.conflicts, resolve }),
              );
              setConflict(null);
              if (choice === "cancel")
                throw new Error(
                  "Сохранение отложено. Черновик остаётся в форме.",
                );
              merged = applyArchiveChanges(current, changes, choice);
            }
            body = JSON.stringify(validateFamily(merged.family));
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
          if (!response.ok)
            throw new Error(result.error || "Не удалось сохранить изменения");
          const data = validateFamily(result.family);
          if (url === "/api/family" && track && base) {
            const changes = archiveChanges(base, data);
            if (changes.length)
              history.current = [...history.current.slice(-19), changes];
          } else if (url !== "/api/family") history.current = [];
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
    [canEdit, publishHistory],
  );
  const save = useCallback(
    (data: Family) =>
      write("/api/family", JSON.stringify(validateFamily(data)), {
        "Content-Type": "application/json",
      }),
    [write],
  );
  const upload = useCallback(
    (file: File, metadata?: PhotoMetadata) =>
      write("/api/photos", file, {
        "Content-Type": file.type,
        "X-Drevo-Upload": "1",
        "X-File-Name": encodeURIComponent(file.name),
        ...(metadata
          ? { "X-Photo-Metadata": encodeURIComponent(JSON.stringify(metadata)) }
          : {}),
      }),
    [write],
  );
  const undo = useCallback(async () => {
    const last = history.current.at(-1),
      current = snapshot.current;
    if (!last || !current) return;
    const reversed = applyArchiveChanges(current, inverseChanges(last));
    if (reversed.conflicts.length)
      throw new Error(
        "Эти сведения уже изменились. Отмена могла бы затронуть новые правки.",
      );
    await write(
      "/api/family",
      JSON.stringify(validateFamily(reversed.family)),
      { "Content-Type": "application/json" },
      false,
    );
    history.current.pop();
    publishHistory();
  }, [write, publishHistory]);
  return {
    conflict,
    undo,
    canUndo: undoCount > 0 && (user?.role === "admin" || !undoRemovesPerson),
    reverseTimeline,
    user,
    readTree,
    readPhotos,
    needsLogin,
    family,
    error,
    canEdit,
    local,
    busy,
    save,
    upload,
    reload: () => setAttempt((n) => n + 1),
  };
}
