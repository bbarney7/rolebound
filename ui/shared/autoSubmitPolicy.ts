export const AUTO_SUBMIT_POLICY_VERSION = "auto-submit-v1";

/** Verbatim disclosure (Setup, Settings, `/acknowledge`, agent prompt). */
export const AUTO_SUBMIT_DISCLOSURE_TEXT =
  "Rolebound submits applications for you automatically. Once a form is complete and valid it clicks Submit without asking you first. This acknowledgement is a one-time setting, not approval of any particular application. Stop the run, or remove a job from the queue, to prevent its submission. At most one application is submitted every ten minutes. CAPTCHAs stop the run unless you enable a paid solver in Settings.";

export const MIN_SUBMIT_INTERVAL_MS = 600_000;

export function isVersionedAutoSubmitAcknowledged(
  acknowledgedAt: string | null | undefined,
  acknowledgedPolicy: string | null | undefined,
): boolean {
  return Boolean(acknowledgedAt) && acknowledgedPolicy === AUTO_SUBMIT_POLICY_VERSION;
}
