import { defineConfig, loadEnv } from 'vite';

/**
 * GitHub Pages serves a project site from `/<repo>/`, so the bundle must be
 * built with a matching base path. `VITE_BASE` supplies it (the deploy workflow
 * sets it from the repository name); the `/` default covers local development
 * and root-domain hosting.
 *
 * `VITE_API_BASE` is the deployed Worker URL. Both can come from the shell or
 * from a `.env.<mode>` file — `--mode e2e` uses `.env.e2e`.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  return {
    base: env['VITE_BASE'] ?? '/',
    build: {
      target: 'es2022',
      outDir: 'dist',
      sourcemap: true,
      // The whole app is a few tens of kilobytes; one chunk loads fastest.
      chunkSizeWarningLimit: 300,
    },
    server: { port: 5173, strictPort: true },
    // Bound to the loopback address explicitly: on CI runners `localhost` can
    // resolve to ::1 first, so a server on `localhost` is unreachable at
    // 127.0.0.1 and the end-to-end runner times out waiting for it.
    preview: { port: 4173, strictPort: true, host: '127.0.0.1' },
  };
});
