import os from "node:os";
import { startUiServer } from "./start";
import { defaultWorkspaceRoot } from "./workspace";

const HOST = "127.0.0.1";
const PORT = Number(process.env.PI_JOBS_PORT || 4747);
const requestedNodeMajor = process.env.PI_JOBS_E2E_NODE_MAJOR;
const githubAuthenticated = process.env.PI_JOBS_E2E_GH_PROBE === "authenticated";
const nodeMajor =
  requestedNodeMajor && /^\d+$/.test(requestedNodeMajor)
    ? Number(requestedNodeMajor)
    : Number(process.versions.node.split(".")[0]) || 0;

process.env.PI_OAUTH_CALLBACK_HOST = "127.0.0.1";

startUiServer({
  root: defaultWorkspaceRoot(),
  host: HOST,
  port: PORT,
  demo: process.env.PI_JOBS_DEMO === "1",
  allowDevProxy: process.env.PI_JOBS_DEV_PROXY === "1",
  providerHost: {
    home: os.homedir(),
    env: process.env,
    platform: process.platform,
    nodeMajor,
    keychainProbe: async () => "absent",
    ghProbe: async () => ({ exitCode: githubAuthenticated ? 0 : 1 }),
  },
});
