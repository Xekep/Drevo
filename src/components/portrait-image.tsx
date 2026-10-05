import { useEffect, useRef, useState, type ReactNode } from "react";
import { mayRetryPortrait, portraitRetryDelays, retryPortraitUrl, waitForPortraitRetry } from "./portrait-retry.ts";

type ImageState = { attempt: number; waiting: boolean; failed: boolean };

function PortraitImageSource({ src, fallback, loading }: {
  src: string;
  fallback: ReactNode;
  loading: "eager" | "lazy";
}) {
  const [state, setState] = useState<ImageState>({ attempt: 0, waiting: false, failed: false });
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  if (state.waiting || state.failed) return <>{fallback}</>;
  return <img src={retryPortraitUrl(src, state.attempt)} alt="" loading={loading}
    onError={() => {
      pending.current?.abort();
      if (state.attempt >= portraitRetryDelays.length) {
        setState({ ...state, failed: true });
        return;
      }
      const controller = new AbortController();
      pending.current = controller;
      setState({ ...state, waiting: true });
      void (async () => {
        await waitForPortraitRetry(portraitRetryDelays[state.attempt], controller.signal);
        if (controller.signal.aborted) return;
        const retry = await mayRetryPortrait(src, controller.signal);
        if (controller.signal.aborted) return;
        setState((previous) => previous.attempt === state.attempt
          ? { attempt: retry ? state.attempt + 1 : state.attempt,
            waiting: false, failed: !retry }
          : previous);
      })();
    }} />;
}

export function PortraitImage({ src, fallback, loading = "lazy" }: {
  src?: string;
  fallback: ReactNode;
  loading?: "eager" | "lazy";
}) {
  return src ? <PortraitImageSource key={src} src={src} fallback={fallback} loading={loading} />
    : <>{fallback}</>;
}
