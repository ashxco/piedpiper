import {
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  type LucideIcon,
} from "lucide-react";

import type { PrStatusIndicator } from "../../lib/openPullRequestLink";

const PR_STATUS_ICONS: Record<PrStatusIndicator["label"], LucideIcon> = {
  "PR open": GitPullRequestIcon,
  "PR draft": GitPullRequestDraftIcon,
  "PR closed": GitPullRequestClosedIcon,
  "PR merged": GitMergeIcon,
};

/** Tells draft and closed apart, which share a colour; takes the label `prStatusIndicator` chose. */
export function PrStatusIcon(props: { label: PrStatusIndicator["label"]; className?: string }) {
  const Icon = PR_STATUS_ICONS[props.label];
  return <Icon aria-hidden="true" {...(props.className ? { className: props.className } : {})} />;
}
