import type { ReactNode } from "react";
import "./profileResumes.css";
import {
  AUTO_SUBMIT_DISCLOSURE_TEXT,
  AUTO_SUBMIT_POLICY_VERSION,
  isVersionedAutoSubmitAcknowledged,
  MIN_SUBMIT_INTERVAL_MS,
} from "../shared/autoSubmitPolicy";
import type { CaptchaProviderChoice } from "../shared/types";
import type { ReadinessAcknowledgement } from "../shared/types";

export type ApplicationsSettingsSectionProps = {
  acknowledgement: ReadinessAcknowledgement | null;
  captchaProvider: CaptchaProviderChoice;
  /** Rolling 24h paid CAPTCHA tasks (T8 wires the live count). */
  captchaDailyPaidTasksCount?: number | null;
};

function formatAckDatePlain(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

const rateLimitMinutes = MIN_SUBMIT_INTERVAL_MS / 60_000;

export function ApplicationsSettingsSection({
  acknowledgement,
  captchaProvider,
  captchaDailyPaidTasksCount = null,
}: ApplicationsSettingsSectionProps) {
  const ack = acknowledgement ?? { at: null, policy: null, current: AUTO_SUBMIT_POLICY_VERSION };
  const versioned = isVersionedAutoSubmitAcknowledged(ack.at, ack.policy);
  const policyChanged =
    Boolean(ack.at) && ack.policy !== null && ack.policy !== ack.current && !versioned;

  let acknowledgementLine: ReactNode;
  if (versioned && ack.at) {
    acknowledgementLine = `You turned on automatic submission on ${formatAckDatePlain(ack.at)}.`;
  } else if (policyChanged) {
    acknowledgementLine = (
      <>
        The submission policy changed since you turned this on.{" "}
        <a href="/setup">Review it in Setup</a>.
      </>
    );
  } else if (!versioned) {
    acknowledgementLine = (
      <>
        Automatic submission is not turned on yet. <a href="/setup">Complete acknowledgement in Setup</a>.
      </>
    );
  } else {
    acknowledgementLine = "Automatic submission is not turned on yet.";
  }

  const policyMetaId = "settings-auto-submit-policy-meta";

  return (
    <section className="rb-settings-section" aria-labelledby="settings-applications-heading">
      <header className="rb-settings-section-head">
        <h2 id="settings-applications-heading" className="rb-h-major">Applications</h2>
        <p>How Rolebound submits job applications from this workspace.</p>
      </header>

      <dl className="rb-settings-dl">
        <div>
          <dt>Submission</dt>
          <dd>Automatic (no per-application confirmation).</dd>
        </div>
        <div>
          <dt>Acknowledgement</dt>
          <dd
            id="settings-auto-submit-ack"
            aria-describedby={ack.policy ? policyMetaId : undefined}
          >
            {acknowledgementLine}
            {ack.policy ? (
              <span id={policyMetaId} className="rb-sr-only">
                Recorded policy version differs from the current submission policy.
              </span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>Rate limit</dt>
          <dd>At most one application every {rateLimitMinutes} minutes.</dd>
        </div>
        <div>
          <dt>Stop</dt>
          <dd>Ends the run and blocks new browser or submit actions for that application.</dd>
        </div>
        <div>
          <dt>Remove from queue</dt>
          <dd>Stops an active apply run for that job and prevents its submission.</dd>
        </div>
        <div>
          <dt>CAPTCHA spend</dt>
          <dd>
            {captchaProvider === "off"
              ? "Paid solving is off — CAPTCHAs pause the run until you solve them manually."
              : `Paid solver enabled (${captchaProvider}).`}
            {captchaDailyPaidTasksCount != null
              ? ` Rolling 24-hour paid tasks: ${captchaDailyPaidTasksCount}.`
              : " Daily paid-task count will appear here when configured."}
          </dd>
        </div>
      </dl>

      <details className="rb-expand-form">
        <summary>Disclosure text</summary>
        <p className="rb-section-note">{AUTO_SUBMIT_DISCLOSURE_TEXT}</p>
      </details>
    </section>
  );
}
