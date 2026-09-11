import { Component, type ReactNode } from "react";

type Props = {
  children: ReactNode;
  message: string;
};
type State = { failed: boolean };

export class LazyChunkBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("Не удалось загрузить часть интерфейса", error);
  }

  render() {
    if (this.state.failed)
      return (
        <div className="archive-status" role="alert">
          <p>{this.props.message}</p>
          <button
            className="primary-action"
            type="button"
            onClick={() => window.location.reload()}
          >
            Обновить страницу
          </button>
        </div>
      );
    return this.props.children;
  }
}
