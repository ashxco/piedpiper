import { memo } from "react";
import { type PendingApproval } from "../../session-logic";

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
}

export const ComposerPendingApprovalPanel = memo(function ComposerPendingApprovalPanel({
  approval,
  pendingCount,
}: ComposerPendingApprovalPanelProps) {
  const isToolApproval = approval.requestType === "dynamic_tool_call";
  const approvalSummary = isToolApproval
    ? "Tool approval requested"
    : approval.requestKind === "command"
      ? "Command approval requested"
      : approval.requestKind === "file-read"
        ? "File-read approval requested"
        : "File-change approval requested";
  const detailLabel = isToolApproval
    ? "Tool"
    : approval.requestKind === "command"
      ? "Command"
      : approval.requestKind === "file-read"
        ? "File to read"
        : "File change";

  return (
    <div className="min-w-0 px-4 py-3.5 sm:px-5 sm:py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="uppercase text-sm tracking-[0.2em]">PENDING APPROVAL</span>
        <span className="text-sm font-medium">{approvalSummary}</span>
        {pendingCount > 1 ? (
          <span className="text-xs text-muted-foreground">1/{pendingCount}</span>
        ) : null}
      </div>
      {approval.detail ? (
        <div className="mt-2 min-w-0 max-w-full">
          <span className="text-xs text-muted-foreground">{detailLabel}</span>
          <pre
            data-approval-detail="complete"
            className="mt-1 max-h-40 min-w-0 max-w-full overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-xs"
          >
            {approval.detail}
          </pre>
        </div>
      ) : null}
      {approval.reason ? (
        <p
          data-approval-reason="true"
          className="mt-2 min-w-0 [overflow-wrap:anywhere] text-xs text-muted-foreground"
        >
          {approval.reason}
        </p>
      ) : null}
    </div>
  );
});
