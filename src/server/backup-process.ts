import { spawn } from "node:child_process";
import { backupWorkerFailureMessage, readBackupWorkerFailure, type BackupWorkerFailure } from "./backup-worker-failure.ts";

// Never run backup configuration through a local shell. All children are bounded
// and cancelled on shutdown; stderr may contain SSH configuration and is not sent to clients.
export function backupProcess(
  command: string,
  args: string[],
  signal: AbortSignal,
  timeout = 30 * 60 * 1000,
  options: { workerDiagnostics?: boolean } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    let failure: BackupWorkerFailure | null = null;
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: options.workerDiagnostics ? ["ignore", "ignore", "ignore", "ipc"] : "ignore",
      signal,
      timeout,
      killSignal: "SIGKILL",
    });
    if (options.workerDiagnostics) child.on("message", value => {
      failure = readBackupWorkerFailure(value) || failure;
    });
    child.once("error", () =>
      reject(
        new Error(
          options.workerDiagnostics && signal.aborted ? "Создание переносимой копии отменено."
            : options.workerDiagnostics ? "Не удалось запустить создание переносимой копии. Проверьте настройку сервера."
            : `Не удалось запустить ${command}; проверьте настройку сервера.`,
        ),
      ),
    );
    child.once("close", code => {
      if (code === 0) return resolve();
      if (options.workerDiagnostics) {
        if (signal.aborted) return reject(new Error("Создание переносимой копии отменено."));
        console.error(JSON.stringify({ event: "backup_worker_failed", exitCode: code, ...failure }));
        return reject(new Error(failure ? backupWorkerFailureMessage(failure)
          : "Создание переносимой копии прервано. Код завершения записан в журнал сервера."));
      }
      reject(new Error(`${command}: операция не завершена. Проверьте соединение, права и свободное место.`));
    });
  });
}
