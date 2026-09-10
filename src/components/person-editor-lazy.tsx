import { lazy, Suspense, type ComponentProps } from "react";

const LoadedPersonEditor = lazy(() =>
  import("./archive-editors").then((module) => ({
    default: module.PersonEditor,
  })),
);

type Props = ComponentProps<typeof LoadedPersonEditor>;

export function PersonEditor(props: Props) {
  return (
    <Suspense
      fallback={
        <p className="flow-intro" role="status">
          Открываем редактор…
        </p>
      }
    >
      <LoadedPersonEditor {...props} />
    </Suspense>
  );
}
