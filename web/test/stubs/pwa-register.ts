/** Stand-in for `virtual:pwa-register`, which only exists under the Vite plugin. */
export const registerSW = (): (() => Promise<void>) => async () => undefined;
