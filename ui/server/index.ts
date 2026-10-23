import { defaultWorkspaceRoot } from "./workspace";
import { startUiServer } from "./start";

const HOST = "127.0.0.1";
const PORT = Number(process.env.PI_JOBS_PORT || 4747);

process.env.PI_OAUTH_CALLBACK_HOST = "127.0.0.1";

startUiServer({
  root: defaultWorkspaceRoot(),
  host: HOST,
  port: PORT,
  demo: process.env.PI_JOBS_DEMO === "1",
  allowDevProxy: process.env.PI_JOBS_DEV_PROXY === "1",
});
