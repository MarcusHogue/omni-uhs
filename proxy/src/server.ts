import { buildApp } from './app.js';
import { config } from './config.js';
import { getCache } from './cache/index.js';

const app = await buildApp();

// Open the cache eagerly so a bad CACHE_DIR fails at startup, not on first use.
getCache();

try {
  await app.listen({ port: config.port, host: config.host });
  // Everything here is worth having at the top of `docker logs`: nine times out
  // of ten a support question is answered by one of these values being wrong.
  app.log.info(
    {
      port: config.port,
      host: config.host,
      cacheDir: config.cacheDir,
      allowlist: config.upstreamAllowlist,
      searchSources: config.searchSources,
      logLevel: config.logLevel,
      userAgent: config.userAgent,
    },
    'omni-uhs proxy ready',
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
