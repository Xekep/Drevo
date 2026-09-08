import { useCallback, useEffect, useRef, useState } from "react";
import { validateFamily, type Family, type ArchiveUser } from "../domain";
export function useArchive() {
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
            setNeedsLogin(false);
            revision.current = result.revision;
            setCanEdit(result.canEdit === true);
            setLocal(result.local === true);
            setUser(result.user || null);
            setReadTree(result.readTree !== false);
            setReadPhotos(result.readPhotos !== false);
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
    async (url: string, body: BodyInit, headers: Record<string, string>) => {
      if (saving.current) throw new Error("Дождитесь завершения сохранения");
      if (!canEdit) throw new Error("Войдите в архив для сохранения изменений");
      saving.current = true;
      setBusy(true);
      try {
        const response = await fetch(url, {
          method: url === "/api/family" ? "PUT" : "POST",
          headers: { ...headers, "If-Match": String(revision.current) },
          body,
        });
        const result = await response.json();
        if (response.status === 401) {
          setCanEdit(false);
          throw new Error("Сеанс завершён. Войдите в архив ещё раз.");
        }
        if (!response.ok)
          throw new Error(result.error || "Не удалось сохранить изменения");
        const data = validateFamily(result.family);
        revision.current = result.revision;
        setFamily(data);
        return data;
      } finally {
        saving.current = false;
        setBusy(false);
      }
    },
    [canEdit],
  );
  const save = useCallback(
    (data: Family) =>
      write("/api/family", JSON.stringify(validateFamily(data)), {
        "Content-Type": "application/json",
      }),
    [write],
  );
  const upload = useCallback(
    (file: File) =>
      write("/api/photos", file, {
        "Content-Type": file.type,
        "X-Drevo-Upload": "1",
        "X-File-Name": encodeURIComponent(file.name),
      }),
    [write],
  );
  return {
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
