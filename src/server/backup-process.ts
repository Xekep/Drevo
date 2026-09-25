import { spawn } from "node:child_process";

// Never run backup configuration through a local shell. All children are bounded
// and cancelled on shutdown; stderr may contain SSH configuration and is not sent to clients.
export function backupProcess(
  command: string,
  args: string[],
  signal: AbortSignal,
  timeout = 30 * 60 * 1000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: "ignore",
      signal,
      timeout,
      killSignal: "SIGKILL",
    });
    child.once("error", () =>
      reject(
        new Error(
          `Не удалось запустить ${command}; проверьте настройку сервера.`,
        ),
      ),
    );
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `${command}: операция не завершена. Проверьте соединение, права и свободное место.`,
            ),
          ),
    );
  });
}
