import { startTestServer, stopTestServer } from "./server.mjs";

export default async function globalSetup() {
  const server = await startTestServer();
  return () => stopTestServer(server);
}
