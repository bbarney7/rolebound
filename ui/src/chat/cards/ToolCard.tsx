import type { ToolCardDetails, ToolCardKind } from "../../../shared/types";
import ApplicationCard, { canRenderApplicationCard } from "./ApplicationCard";
import ConnectionCard, { canRenderConnectionCard } from "./ConnectionCard";
import JobListCard, { canRenderJobListCard } from "./JobListCard";
import ProfileDiffCard, { canRenderProfileDiffCard } from "./ProfileDiffCard";
import RunProgressCard, { canRenderRunProgressCard } from "./RunProgressCard";

export function canRenderToolCard(details: ToolCardDetails): boolean {
  switch (details.card) {
    case "job-list":
      return canRenderJobListCard(details);
    case "profile-diff":
      return canRenderProfileDiffCard(details);
    case "run-progress":
      return canRenderRunProgressCard(details);
    case "application":
      return canRenderApplicationCard(details);
    case "connection":
      return canRenderConnectionCard(details);
    default:
      return false;
  }
}

export default function ToolCard({
  details,
  onSend,
}: {
  details: ToolCardDetails;
  onSend: (message: string) => void;
}) {
  const kind = details.card as ToolCardKind;
  switch (kind) {
    case "job-list":
      return canRenderJobListCard(details) ? <JobListCard details={details} onSend={onSend} /> : null;
    case "profile-diff":
      return canRenderProfileDiffCard(details) ? <ProfileDiffCard details={details} /> : null;
    case "run-progress":
      return canRenderRunProgressCard(details) ? <RunProgressCard details={details} /> : null;
    case "application":
      return canRenderApplicationCard(details) ? <ApplicationCard details={details} /> : null;
    case "connection":
      return canRenderConnectionCard(details) ? <ConnectionCard details={details} /> : null;
    default:
      return null;
  }
}
