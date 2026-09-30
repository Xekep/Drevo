declare module "@internetarchive/bookreader/src/BookReaderPlugin.js" {
  export class BookReaderPlugin {
    constructor(reader: unknown);
    setup(options: unknown): void;
    init(): void;
    _configurePageContainer(pageContainer: unknown): void;
    _configureToolbar(toolbar: unknown): void;
    _bindNavigationHandlers(): void;
    extendNavBar(navbar: unknown): void;
  }
}
