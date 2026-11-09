import { XIcon } from "lucide-react";
import { useLayoutEffect, useRef } from "react";

import { DIFF_FIND_SCOPE_ATTRIBUTE } from "~/lib/diffFind";
import { useReviewCommentFormStore } from "~/reviewCommentDraftStore";

import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

// The form is slotted into the viewer's shadow DOM, which renders a few frames after it mounts.
const FOCUS_MAX_FRAMES = 30;

/** False once the user has moved on to something outside the diff panel. */
function canTakeFocus(): boolean {
  const active = document.activeElement;
  return (
    !active || active === document.body || active.closest(`[${DIFF_FIND_SCOPE_ATTRIBUTE}]`) !== null
  );
}

// One form exists at a time. Outlives the element, because a refreshed patch can remount the file.
const formFocusMemory = {
  draftId: null as string | null,
  hadFocus: false,
  selectionStart: 0,
  selectionEnd: 0,
};

/** The inline form under the selected diff lines. Its text lives in the store so a remount keeps it. */
export function DiffReviewCommentForm(props: {
  draftId: string;
  rangeLabel: string;
  onCancel: () => void;
  onSubmit: (text: string) => void;
}) {
  const { draftId } = props;
  const text = useReviewCommentFormStore((state) => state.text);
  const setText = useReviewCommentFormStore((state) => state.setText);
  const canSubmit = text.trim().length > 0;
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Not autoFocus: only a new form, or one that had focus, may take it, never mid-typing elsewhere.
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const isNewDraft = formFocusMemory.draftId !== draftId;
    const restoring = !isNewDraft && formFocusMemory.hadFocus;
    const { selectionStart, selectionEnd } = formFocusMemory;
    formFocusMemory.draftId = draftId;
    formFocusMemory.hadFocus = false;

    let wantsFocus = isNewDraft || restoring;
    let framesLeft = FOCUS_MAX_FRAMES;
    let frameId = 0;
    const tryFocus = () => {
      if (!canTakeFocus()) {
        wantsFocus = false;
        return;
      }
      textarea.focus({ preventScroll: restoring });
      if (document.activeElement === textarea) {
        wantsFocus = false;
        if (restoring) textarea.setSelectionRange(selectionStart, selectionEnd);
        return;
      }
      framesLeft -= 1;
      if (framesLeft > 0) frameId = window.requestAnimationFrame(tryFocus);
      else wantsFocus = false;
    };
    if (wantsFocus) tryFocus();

    return () => {
      window.cancelAnimationFrame(frameId);
      const hasFocus = document.activeElement === textarea;
      formFocusMemory.hadFocus = hasFocus || wantsFocus;
      formFocusMemory.selectionStart = hasFocus ? textarea.selectionStart : selectionStart;
      formFocusMemory.selectionEnd = hasFocus ? textarea.selectionEnd : selectionEnd;
    };
  }, [draftId]);

  return (
    <div
      data-review-comment-form
      className="mx-2 my-1.5 flex flex-col gap-1.5 rounded-md border border-border bg-popover p-2 font-sans"
    >
      <span className="text-[11px] text-muted-foreground">Comment on {props.rangeLabel}</span>
      <Textarea
        ref={textareaRef}
        size="sm"
        aria-label={`Comment on ${props.rangeLabel}`}
        placeholder="Leave a comment for the next prompt"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            props.onCancel();
          } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && canSubmit) {
            event.preventDefault();
            props.onSubmit(text);
          }
        }}
      />
      <div className="flex justify-end gap-1.5">
        <Button type="button" variant="ghost" size="xs" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button type="button" size="xs" disabled={!canSubmit} onClick={() => props.onSubmit(text)}>
          Comment
        </Button>
      </div>
    </div>
  );
}

/** A saved comment waiting for the next prompt, shown under the lines it is about. */
export function DiffReviewCommentCard(props: {
  rangeLabel: string;
  text: string;
  onDelete: () => void;
}) {
  return (
    <div
      data-review-comment
      className="mx-2 my-1.5 flex items-start gap-2 rounded-md border border-border/70 bg-popover px-2.5 py-1.5 font-sans text-xs"
    >
      <div className="min-w-0 flex-1">
        <span className="block text-[11px] text-muted-foreground">
          Comment on {props.rangeLabel}
        </span>
        <span className="block whitespace-pre-wrap wrap-break-word text-foreground">
          {props.text}
        </span>
      </div>
      <button
        type="button"
        className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        aria-label={`Delete comment on ${props.rangeLabel}`}
        title="Delete comment"
        onClick={props.onDelete}
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}
