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

function formatAckDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
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
  const needsSetup = !versioned;

  return (
    <section className="rb-settings-section" aria-labelledby="settings-applications-heading">
      <header className="rb-settings-section-head">
        <h2 id="settings-applications-heading" className="rb-h-major">Applications</h2>
        <p>How Rolebound submits job applications from this workspace.</p>
      </header>

      <p className="rb-section-note">
        <strong>Submission:</strong> Automatic (no per-application confirmation).
      </p>
      <p className="rb-section-note">
        <strong>Acknowledgement:</strong>{" "}
        {versioned && ack.at ? (
          <>
            Recorded {formatAckDate(ack.at)} under policy <code>{ack.policy}</code> (current{" "}
            <code>{ack.current}</code>).
          </>
        ) : needsSetup ? (
          <>
            Not recorded for the current policy. <a href="/setup">Complete acknowledgement in Setup</a>.
          </>
        ) : (
          <>Not recorded.</>
        )}
      </p>
      <p className="rb-section-note">
        <strong>Rate limit:</strong> At most one application every {rateLimitMinutes} minutes.
      </p>
      <p className="rb-section-note">
        <strong>Stop:</strong> Ends the run and blocks new browser or submit actions for that application.
      </p>
      <p className="rb-section-note">
        <strong>Remove from queue:</strong> Stops an active apply run for that job and prevents its submission.
      </p>
      <p className="rb-section-note">
        <strong>CAPTCHA spend:</strong>{" "}
        {captchaProvider === "off"
          ? "Paid solving is off — CAPTCHAs pause the run until you solve them manually."
          : `Paid solver enabled (${captchaProvider}).`}
        {captchaDailyPaidTasksCount != null
          ? ` Rolling 24-hour paid tasks: ${captchaDailyPaidTasksCount}.`
          : " Daily paid-task count will appear here when configured."}
      </p>

      <details className="rb-expand-form">
        <summary>Disclosure text</summary>
        <p className="rb-section-note">{AUTO_SUBMIT_DISCLOSURE_TEXT}</p>
      </details>
    </section>
  );
}
