import { useCallback, useEffect, useState } from "react";
import type { ConnectionList } from "../../shared/providers";
import type { ReadinessPayload } from "../../shared/types";
import ProviderSetup from "../ProviderSetup";
import { fetchConnections, fetchReadiness } from "../settings";
import BrandMark from "./cards/BrandMark";


export default function FirstLaunch({
  connectionReady,
  onReadinessChange,
  onConnectionsChange,
}: {
  connectionReady: boolean;
  onReadinessChange: (ready: ReadinessPayload) => void;
  onConnectionsChange: (connections: ConnectionList) => void;
}) {
  const [connections, setConnections] = useState<ConnectionList | null>(null);
  const [nodeMajor, setNodeMajor] = useState(24);

  const reload = useCallback(async () => {
    const [ready, list] = await Promise.all([fetchReadiness(), fetchConnections()]);
    setNodeMajor(ready.serverRuntime.nodeMajor);
    setConnections(list);
    onReadinessChange(ready);
    onConnectionsChange(list);
  }, [onConnectionsChange, onReadinessChange]);

  useEffect(() => {
    void reload().catch(() => {
      /* App refresh still owns global error state */
    });
  }, [reload]);

  const connectedCopy =
    "Tell me what you're looking for, drop in your resume, or paste a job link. I'll keep everything in your workspace, and you can edit it any time.";
  const setupCopy =
    "Connect an AI account to get started. Then add your resume and tell me what you’re looking for.";

  return (
    <div className="rb-chat-intro rb-first-launch">
      <div className="rb-first-launch-hero">
        <BrandMark className="rb-first-launch-mark" />
        <div className="rb-first-launch-copy">
          <h1>Let&apos;s find your next role.</h1>
          <p>{connectionReady ? connectedCopy : setupCopy}</p>
        </div>
      </div>

      {!connectionReady && connections ? (
        <section className="rb-first-launch-card" aria-labelledby="rb-first-launch-detected-heading">
          <h2 id="rb-first-launch-detected-heading" className="rb-first-launch-card-title">
            Connect an AI model
          </h2>
          <div className="rb-first-launch-setup">
            <ProviderSetup connections={connections} nodeMajor={nodeMajor} onUpdated={reload} />
          </div>
        </section>
      ) : null}
    </div>
  );
}
