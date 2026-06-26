import express from 'express';

/** Redirects all plain-HTTP traffic on port 80 to HTTPS. */
export function startRedirectServer(): void {
  const httpServer = express();
  httpServer.get('*', (req, res) => {
    res.redirect('https://' + req.headers.host + req.url);
  });
  httpServer.listen(80, () => console.log('Started HTTP→HTTPS redirect server.'));
}
