/** Playwright is an optional peer dependency — suppress TS2307 for dynamic import */
declare module "playwright" {
  const chromium: {
    launch(options?: { headless?: boolean }): Promise<any>;
  };
  export { chromium };
}
