import { useState } from "react";

export function CreatePersonalArchive() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function create() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/account/archives", {
        method: "POST",
        headers: { "X-Drevo-New-Archive": "1" },
        credentials: "same-origin",
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Не удалось создать дерево");
      window.location.assign(`/a/${encodeURIComponent(data.archiveId)}/tree`);
    } catch (cause) {
      setError((cause as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="account-create-archive">
      <button
        type="button"
        className="account-row-action"
        disabled={busy}
        onClick={() => void create()}
      >
        {busy ? "Создаём дерево…" : "Создать новое дерево"}
      </button>
      {error && (
        <p className="account-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
