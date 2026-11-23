// The Vercel function. The server is built into dist/ first (see
// vercel.json), so this only hands the bundled Express app to the runtime.
export { default } from '../dist/vercel.js';
