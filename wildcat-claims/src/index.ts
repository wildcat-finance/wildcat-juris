import fs from 'fs';
import https from 'https';
import { createApp } from './app';

/**
 * Local / self-hosted entrypoint. (On Vercel the app is served via api/index.ts instead —
 * see DEPLOY_VERCEL.md.) Builds the Express app and listens; in MODE=production it terminates
 * TLS on 443 with a port-80 redirect.
 */
async function main(): Promise<void> {
  const app = createApp();

  const PROD = process.env.MODE === 'production';
  const PORT = PROD ? 443 : Number(process.env.PORT ?? 3001);

  if (PROD && PORT === 443) {
    const base = '/etc/letsencrypt/live/claims.wildcat.finance';
    const credentials = {
      key: fs.readFileSync(`${base}/privkey.pem`, 'utf8'),
      cert: fs.readFileSync(`${base}/cert.pem`, 'utf8'),
      ca: fs.readFileSync(`${base}/chain.pem`, 'utf8'),
    };
    https.createServer(credentials, app).listen(PORT, () => console.log(`listening on ${PORT} (https)`));
    const { startRedirectServer } = await import('./httpRedirect');
    startRedirectServer();
  } else {
    app.listen(PORT, () => console.log(`listening on ${PORT} (http)`));
  }
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
