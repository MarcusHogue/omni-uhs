import { buildApp } from './app.js';
import { config } from './config.js';
import { getCache } from './cache/index.js';

const app = await buildApp();

// Open the cache eagerly so a bad CACHE_DIR fails at startup, not on first use.
getCache();

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    {
      cacheDir: config.cacheDir,
      allowlist: config.upstreamAllowlist,
      userAgent: config.userAgent,
    },
    'hint-reader proxy ready',
  );
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
