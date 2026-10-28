type SmartCaptcha = {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      invisible: true;
      hl: "ru";
      callback: (token: string) => void;
    },
  ): number;
  execute(id: number): void;
  destroy(id: number): void;
  subscribe(id: number, event: string, callback: () => void): () => void;
};
declare global {
  interface Window {
    smartCaptcha?: SmartCaptcha;
    drevoEmailCaptchaReady?: () => void;
  }
}

let loading: Promise<SmartCaptcha> | undefined;
function loadCaptcha() {
  if (window.smartCaptcha) return Promise.resolve(window.smartCaptcha);
  if (loading) return loading;
  const pending = new Promise<SmartCaptcha>((resolve, reject) => {
    const script = document.createElement("script");
    const finish = (api?: SmartCaptcha) => {
      clearTimeout(timeout);
      delete window.drevoEmailCaptchaReady;
      script.onerror = null;
      if (api) resolve(api);
      else {
        script.remove();
        reject(
          new Error(
            "Не удалось загрузить защиту от ботов. Проверьте соединение и повторите попытку.",
          ),
        );
      }
    };
    const timeout = setTimeout(() => finish(), 10_000);
    window.drevoEmailCaptchaReady = () => finish(window.smartCaptcha);
    script.src =
      "https://smartcaptcha.yandexcloud.net/captcha.js?render=onload&onload=drevoEmailCaptchaReady";
    script.async = true;
    script.onerror = () => finish();
    document.head.append(script);
  });
  loading = pending;
  void pending.catch(() => {
    if (loading === pending) loading = undefined;
  });
  return pending;
}

/** Each submit owns its one-use widget and destroys it on success or cancel. */
export async function solveEmailCaptcha(
  siteKey: string,
  container: HTMLElement,
  signal: AbortSignal,
) {
  const api = await loadCaptcha();
  signal.throwIfAborted();
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let widget: number | undefined;
    const subscriptions: Array<() => void> = [];
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const finish = (token?: string) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      signal.removeEventListener("abort", abort);
      subscriptions.forEach((unsubscribe) => unsubscribe());
      // Provider callbacks can run inside execute; defer disposal out of its stack.
      queueMicrotask(() => {
        if (widget !== undefined) api.destroy(widget);
      });
      if (token) resolve(token);
      else
        reject(new Error("Проверка защиты не завершена. Попробуйте ещё раз."));
    };
    const abort = () => finish();
    signal.addEventListener("abort", abort, { once: true });
    timers.push(setTimeout(() => finish(), 120_000));
    try {
      widget = api.render(container, {
        sitekey: siteKey,
        invisible: true,
        hl: "ru",
        callback: (token) => finish(token),
      });
      for (const event of [
        "network-error",
        "javascript-error",
        "token-expired",
      ])
        subscriptions.push(api.subscribe(widget, event, () => finish()));
      // Success and challenge-hidden can occur in the same provider callback.
      subscriptions.push(
        api.subscribe(widget, "challenge-hidden", () => {
          timers.push(setTimeout(() => finish(), 0));
        }),
      );
      api.execute(widget);
    } catch {
      finish();
    }
  });
}
