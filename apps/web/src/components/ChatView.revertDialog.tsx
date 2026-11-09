import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";

export interface RevertCheckpointDialogState {
  turnCount: number;
  open: boolean;
}

/** Confirms reverting to a message, offering to rewind only the conversation and keep the files. */
export function RevertCheckpointDialog(props: {
  state: RevertCheckpointDialogState | null;
  onCancel: () => void;
  onClosed: () => void;
  onConfirm: (restoreFiles: boolean) => void;
}) {
  const { state, onCancel, onClosed, onConfirm } = props;
  return (
    <AlertDialog
      open={state?.open ?? false}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      onOpenChangeComplete={(open) => {
        if (!open) onClosed();
      }}
    >
      <AlertDialogPopup className="max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>Edit from here?</AlertDialogTitle>
          <AlertDialogDescription className="space-y-2">
            <span className="block">
              This message and everything after it will be discarded, and this cannot be undone. Its
              text and images return to the composer.
            </span>
            <span className="block">
              <span className="font-medium text-foreground">Restore files</span> puts workspace
              files back to their state at that message. Changes you made yourself since then,
              including uncommitted edits and new files, will be lost.
            </span>
            <span className="block">
              <span className="font-medium text-foreground">Keep file changes</span> rewinds the
              conversation while files stay as they are. The next turn's diff will also include the
              kept changes.
            </span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button variant="outline" onClick={() => onConfirm(false)}>
            Keep file changes
          </Button>
          <Button variant="destructive" onClick={() => onConfirm(true)}>
            Restore files
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
