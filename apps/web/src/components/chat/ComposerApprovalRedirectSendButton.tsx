import { SendHorizontalIcon } from "lucide-react";

import { Button } from "../ui/button";

/** Submits the composer during an approval, which declines it and redirects the agent. */
export function ComposerApprovalRedirectSendButton(props: {
  hasSendableContent: boolean;
  disabled: boolean;
}) {
  if (!props.hasSendableContent) return null;
  return (
    <Button
      type="submit"
      size="sm"
      variant="outline"
      disabled={props.disabled}
      title="Decline the approval and send this message instead"
      data-testid="composer-approval-redirect-send"
    >
      <SendHorizontalIcon />
      Decline &amp; send
    </Button>
  );
}
