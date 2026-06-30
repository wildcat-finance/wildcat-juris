import { createApp } from '../src/app';

/**
 * Vercel Node serverless entrypoint. An Express app is a valid (req, res) handler, so the
 * whole app — the single-page frontend and the API routes — is served from this one function.
 * vercel.json rewrites every path to it. Configuration comes from Vercel environment variables
 * (RPC_URL, BORROWER_ADDRESS, DEFAULT_BUFFER_DAYS, …); see DEPLOY_VERCEL.md.
 */
export default createApp();
